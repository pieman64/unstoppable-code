/**
 * @jest-environment jsdom
 *
 * Dynamic Home onboarding suggestions module: per-step row rendering
 * (including the roles tile picker and plugin-suggestion rows), CTA
 * behaviors (prompt injection + arming, pipeline-mode handoff,
 * branch-picker staging, plugin enablement), per-entry dismissal,
 * send-driven completion, and persistent progress. Uses the repo's
 * createRoot + act jsdom convention; AuthLoginModal, the
 * plugin-suggestion source, and the status hooks are stubbed so the suite
 * exercises only the module logic.
 */
import { resetDailyCreditDripOptInCacheForTests } from '@/hooks/useDailyCreditDripOptIn';

const mockRefreshAiCreditsAfterDripChange = jest.fn();
jest.mock('@/lib/ai-credits-refresh', () => ({
  refreshAiCreditsAfterDripChange: (): unknown =>
    mockRefreshAiCreditsAfterDripChange(),
}));

Object.defineProperty(globalThis, 'IS_REACT_ACT_ENVIRONMENT', {
  configurable: true,
  value: true,
});

import { useFeatureFlagsStore } from '@/stores/featureFlagsStore';
import { act, createElement, type JSX } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import type {
  AgentProviderAuthStatus,
  GitHubCliStatus,
  HomeOnboardingSuggestionsPreferences,
  WorkspaceReadinessIssue,
} from '@canopy/desktop-shared/types';
import type { ProfileRoleId } from '@canopy/protocol/plugin-catalog';
import { useOnboardingSuggestionSurfaces } from '@/stores/onboardingSuggestionSurfacesStore';
import { useOnboardingChecklistStore } from '@/stores/onboardingChecklistStore';
import { useGlobalFocusShortcutStore } from '@/stores/globalFocusShortcutStore';
import { useLaunchAtLoginStore } from '@/stores/launchAtLoginStore';
import { useImportProjectsModalStore } from '@/stores/importProjectsModalStore';
import { brandText } from '@/lib/brand';
import { useRepoRulesModalStore } from '@/stores/repoRulesModalStore';
import {
  HomeOnboardingSuggestions,
  resetCursorRulesPresenceCacheForTests,
} from '../HomeOnboardingSuggestions';
import { installOnboardingPlugin } from '../installOnboardingPlugin';
jest.mock('../installOnboardingPlugin', () => ({
  installOnboardingPlugin: jest
    .fn()
    .mockResolvedValue({ marketplaceId: 'curated', name: 'notion' }),
}));
import {
  addRepoTryPrompt,
  LINEAR_TRY_PROMPT,
  type OnboardingPluginSuggestionInput,
} from '../queue';
import type * as TelemetryModule from '../telemetry';
import {
  resetOnboardingSuggestionsImpressionForTests,
  trackOnboardingSuggestionDismiss,
  trackOnboardingSuggestionsImpression,
} from '../telemetry';

jest.mock('../telemetry', () => ({
  ...jest.requireActual<typeof TelemetryModule>('../telemetry'),
  trackOnboardingSuggestionsImpression: jest.fn(),
  trackOnboardingSuggestionDismiss: jest.fn(),
}));

interface ProjectStub {
  id: string;
  type: string;
  name: string;
}

const state: {
  claude: AgentProviderAuthStatus | null;
  codex: AgentProviderAuthStatus | null;
  github: GitHubCliStatus | null;
  linearAvailable: boolean;
  creditsEligible: boolean;
  projects: ProjectStub[];
  addWorkspaceModalOpen: boolean;
  pluginSuggestions: OnboardingPluginSuggestionInput[];
  pluginSuggestionsReady: boolean;
  activePage: string;
} = {
  claude: null,
  codex: null,
  github: null,
  linearAvailable: false,
  creditsEligible: false,
  projects: [],
  addWorkspaceModalOpen: false,
  pluginSuggestions: [],
  pluginSuggestionsReady: false,
  activePage: 'home',
};

let mockCursorAvailable = false;
jest.mock('@/hooks/useCursorChatAvailable', () => ({
  useCursorChatAvailable: (): boolean => mockCursorAvailable,
}));

jest.mock('@/hooks/useClaudeAuthStatus', () => ({
  useClaudeAuthStatus: (): AgentProviderAuthStatus | null => state.claude,
  invalidateClaudeAuthStatusCache: jest.fn(),
}));
jest.mock('@/hooks/useCodexAuthStatus', () => ({
  useCodexAuthStatus: (): AgentProviderAuthStatus | null => state.codex,
  invalidateCodexAuthStatusCache: jest.fn(),
}));
jest.mock('@/hooks/useGitHubCliStatus', () => ({
  useGitHubCliStatus: (): GitHubCliStatus | null => state.github,
  invalidateGitHubCliStatusCache: jest.fn(),
}));
jest.mock('@/hooks/useLinearStatus', () => ({
  useLinearAvailability: (): {
    status: { authenticated: boolean; displayName: null; error: null } | null;
    available: boolean;
    tokenLoaded: boolean;
    tokenPresent: boolean;
  } =>
    state.linearAvailable
      ? {
          status: { authenticated: true, displayName: null, error: null },
          available: true,
          tokenLoaded: true,
          tokenPresent: true,
        }
      : {
          status: null,
          available: false,
          tokenLoaded: true,
          tokenPresent: false,
        },
}));
jest.mock('@/hooks/useAiCreditsAvailability', () => ({
  useAiCreditsAvailability: (): {
    eligible: boolean;
    loading: boolean;
    inconclusive: boolean;
  } => ({
    eligible: state.creditsEligible,
    loading: false,
    inconclusive: false,
  }),
}));
jest.mock('@/hooks/useCurrentUiStateReporter', () => ({
  useCurrentUiStateReporter: jest.fn(),
}));
jest.mock('@/hooks/useCuratedMcpServers', () => ({
  useCuratedMcpServers: (): {
    entries: never[];
    loading: boolean;
    error: null;
    refresh: () => void;
  } => ({ entries: [], loading: false, error: null, refresh: jest.fn() }),
}));
jest.mock('@/components/shared/McpServerLogo', () => ({
  McpServerLogo: (props: {
    curatedKey?: string;
    chrome?: 'default' | 'transparent';
  }): JSX.Element =>
    createElement('div', {
      'data-testid': 'mcp-server-logo-stub',
      'data-curated-key': props.curatedKey,
      'data-chrome': props.chrome,
    }),
}));

const mockArmOnboardingSuggestion = jest.fn();
const mockDisarmOnboardingSuggestion = jest.fn();
jest.mock('../completionWriter', () => ({
  armOnboardingSuggestion: (
    entryId: string,
    target?: { chatId: string },
  ): void => {
    if (target) mockArmOnboardingSuggestion(entryId, target);
    else mockArmOnboardingSuggestion(entryId);
  },
  disarmOnboardingSuggestion: (entryId?: string): void => {
    mockDisarmOnboardingSuggestion(entryId);
  },
  onOnboardingSuggestionCompleted: (): (() => void) => () => undefined,
}));

const mockEnablePlugins = jest.fn<boolean, [readonly string[]]>();
/** The Marketing template's built-in Git plugin ref, as the catalog ships it. */
const BUILTIN_GIT_REF = {
  type: 'claude_plugin',
  marketplace: { type: 'builtin', id: 'app' },
  plugin_name: 'builtin-git',
} as const;
let blueprintSuggestions: OnboardingPluginSuggestionInput[] = [];
let lastPluginSuggestionOptions: unknown;
jest.mock('../usePluginSuggestions', () => ({
  usePluginSuggestions: (
    _roles: unknown,
    options?: unknown,
  ): {
    suggestions: OnboardingPluginSuggestionInput[];
    blueprintSuggestions: OnboardingPluginSuggestionInput[];
    ready: boolean;
    enablePlugins: (keys: readonly string[]) => boolean;
  } => {
    lastPluginSuggestionOptions = options;
    return {
      suggestions: state.pluginSuggestions,
      blueprintSuggestions,
      ready: state.pluginSuggestionsReady,
      enablePlugins: mockEnablePlugins,
    };
  },
}));

interface MockAuthLoginModalProps {
  provider: string;
  onAuthorizationUrl?: (url: string) => void;
}

interface MockOnboardingChatBrowserTarget {
  projectId: string;
  worktreeId: string;
  chatId: string;
}

const mockAuthLoginModal = jest.fn<void, [MockAuthLoginModalProps]>();
jest.mock('@/components/settings/AuthLoginModal', () => ({
  AuthLoginModal: (props: MockAuthLoginModalProps): JSX.Element => {
    mockAuthLoginModal(props);
    return createElement('div', { 'data-testid': 'auth-login-modal-stub' });
  },
}));

const mockOpenOnboardingAuthorizationUrl = jest
  .fn<Promise<boolean>, [MockOnboardingChatBrowserTarget, string]>()
  .mockResolvedValue(true);
jest.mock('../openOnboardingAuthorizationUrl', () => ({
  openOnboardingAuthorizationUrl: (
    ...args: [MockOnboardingChatBrowserTarget, string]
  ): Promise<boolean> => mockOpenOnboardingAuthorizationUrl(...args),
}));

const mockNavigate = jest.fn();
const mockOpenAddWorkspaceModal = jest.fn();
const mockOpenSettings = jest.fn();
const mockOpenPluginsNavigation = jest.fn();
jest.mock('@/stores/navigationStore', () => ({
  useNavigationStore: Object.assign(
    (selector: (s: Record<string, unknown>) => unknown): unknown =>
      selector({
        addWorkspaceModalOpen: state.addWorkspaceModalOpen,
        activePage: state.activePage,
      }),
    {
      getState: (): Record<string, unknown> => ({
        navigate: mockNavigate,
        openAddWorkspaceModal: mockOpenAddWorkspaceModal,
        openSettings: mockOpenSettings,
        openPluginsNavigation: mockOpenPluginsNavigation,
      }),
    },
  ),
}));

const mockSetMode = jest.fn();
const mockRequestBranchPickerTab = jest.fn();
const mockStageTaskPlanPreset = jest.fn();
const mockSelectWorkspace = jest.fn();
let mockComposerWorkspaceId: string | null = 'p1';
jest.mock('@/stores/homeComposerStore', () => ({
  useHomeComposerStore: {
    getState: (): Record<string, unknown> => ({
      workspaceId: mockComposerWorkspaceId,
      selectWorkspace: mockSelectWorkspace,
      setMode: mockSetMode,
      requestBranchPickerTab: mockRequestBranchPickerTab,
      stageTaskPlanPreset: mockStageTaskPlanPreset,
    }),
  },
}));

jest.mock('@/stores/projectsStore', () => ({
  useProjectsStore: Object.assign(
    (
      selector: (s: {
        projects: ProjectStub[];
        hasHydratedProjects: boolean;
      }) => unknown,
    ): unknown =>
      selector({ projects: state.projects, hasHydratedProjects: true }),
    {
      getState: (): {
        projects: ProjectStub[];
        hasHydratedProjects: boolean;
      } => ({
        hasHydratedProjects: true,
        projects: state.projects,
      }),
    },
  ),
}));

jest.mock('@/stores/observabilityStore', () => ({
  useObservabilityStore: (
    selector: (s: {
      refreshProviderUsageDetails: () => Promise<void>;
    }) => unknown,
  ): unknown =>
    selector({ refreshProviderUsageDetails: () => Promise.resolve() }),
}));

/** A settled GitHub probe with nothing connected (`null` means "still checking"). */
function notConnectedGh(): GitHubCliStatus {
  return {
    authenticated: false,
    username: null,
    error: null,
    tokenSource: null,
    envOverride: false,
    envOverrideName: null,
    hasCredentialStoreLogin: false,
  };
}

function connectedAuth(): AgentProviderAuthStatus {
  return {
    authenticated: true,
    accountLabel: 'user@example.com',
    detail: null,
    error: null,
  };
}

function persistedState(
  entries: HomeOnboardingSuggestionsPreferences['entries'] = {},
): HomeOnboardingSuggestionsPreferences {
  return {
    startedAt: '2026-08-27T00:00:00.000Z',
    entries: { ...entries },
  };
}

/** AI providers resolved — the state most step tests start from. */
function providersDone(
  entries: HomeOnboardingSuggestionsPreferences['entries'] = {},
): HomeOnboardingSuggestionsPreferences {
  return persistedState({
    'agent-connections': { completedAt: 'x' },
    ...entries,
  });
}

/** Earlier setup was resolved before exercising this row's action. */
function stepReady(
  entryId: string,
  entries: HomeOnboardingSuggestionsPreferences['entries'] = {},
): HomeOnboardingSuggestionsPreferences {
  const ids = [
    'agent-connections',
    'add-repo',
    'github',
    'plugin-examples-preview',
    'plan-mode',
    'linear',
    'focus-shortcut',
    'launch-at-login',
    'plugin:curated/notion',
  ];
  return persistedState({
    ...Object.fromEntries(
      ids
        .slice(0, ids.indexOf(entryId))
        .map((id) => [id, { completedAt: 'x' }]),
    ),
    ...entries,
  });
}

type PersistedUpdater = (
  previous: HomeOnboardingSuggestionsPreferences,
) => HomeOnboardingSuggestionsPreferences;

const onUpdatePersisted = jest.fn<void, [PersistedUpdater]>();
const onInjectPrompt = jest.fn();
const onChangeRoles = jest.fn();

let container: HTMLDivElement;
let root: Root;

beforeEach(() => {
  mockCursorAvailable = false;
  jest.clearAllMocks();
  useOnboardingChecklistStore.setState({ state: null, hydrated: false });
  useGlobalFocusShortcutStore.setState({
    status: null,
    hydrated: false,
    busy: false,
  });
  useLaunchAtLoginStore.setState({
    status: null,
    hydrated: false,
    busy: false,
    error: null,
  });
  useOnboardingSuggestionSurfaces.setState({
    chat: null,
    chatPromptTargetId: null,
    chatBrowserTarget: null,
    chatBlueprint: null,
    chatBlueprintPending: false,
    chatBlueprintOwner: null,
    homeResumePending: false,
    planModeHighlight: false,
    modelPickerHighlightTarget: null,
  });
  blueprintSuggestions = [];
  lastPluginSuggestionOptions = undefined;
  resetOnboardingSuggestionsImpressionForTests();
  resetDailyCreditDripOptInCacheForTests();
  resetCursorRulesPresenceCacheForTests();
  mockRefreshAiCreditsAfterDripChange.mockResolvedValue({
    eligible: true,
    loading: false,
    inconclusive: false,
  });
  state.claude = null;
  state.codex = null;
  state.github = null;
  state.linearAvailable = false;
  state.creditsEligible = false;
  state.projects = [];
  state.addWorkspaceModalOpen = false;
  state.pluginSuggestions = [];
  state.pluginSuggestionsReady = false;
  state.activePage = 'home';
  mockComposerWorkspaceId = 'p1';
  mockEnablePlugins.mockReturnValue(true);
  Object.defineProperty(window, 'api', {
    configurable: true,
    value: {
      externalProjects: {
        readProviderPresence: jest
          .fn()
          .mockResolvedValue({ providerStoresPresent: false }),
      },
      loadGitHubPat: jest.fn().mockResolvedValue(''),
      getWorkspaceReadiness: jest.fn().mockResolvedValue({ issues: [] }),
      refreshGitHubCredentials: jest.fn().mockResolvedValue(undefined),
      loadPreferences: jest
        .fn()
        .mockResolvedValue({ osNotifications: { enabled: false } }),
      onPreferencesSynced: jest.fn().mockReturnValue(() => {}),
      // The daily free AI Credits opt-in reads the cloud preference on
      // mount. Unavailable (no credential) keeps it out of the queue, so the
      // order assertions below are unaffected.
      loadCloudDailyCreditDrip: jest.fn().mockResolvedValue({
        available: false,
        resolved: true,
        preference: { enabled: false, decidedAt: null, capCredits: 10 },
      }),
      saveCloudDailyCreditDrip: jest.fn(),
      // The focus-shortcut entry (CAN-1963) reads the live registration
      // status on mount. Off keeps that row in its asking state.
      globalFocusShortcut: {
        getStatus: jest.fn().mockResolvedValue({
          enabled: false,
          accelerator: 'CommandOrControl+Shift+O',
          registered: false,
          platform: 'darwin',
        }),
        update: jest.fn(),
        onStatusChanged: jest.fn().mockReturnValue(() => {}),
      },
      // Launch at sign-in (CAN-3449) reads the OS on mount. An unpackaged
      // build leaves the entry out, which keeps the queues below unchanged.
      launchAtLogin: {
        getStatus: jest.fn().mockResolvedValue({
          platform: 'darwin',
          supported: false,
          unsupportedReason: 'development-build',
          enabled: false,
          pendingApproval: false,
        }),
        setEnabled: jest.fn(),
        openSystemSettings: jest.fn().mockResolvedValue(undefined),
        onStatusChanged: jest.fn().mockReturnValue(() => {}),
      },
    },
  });
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
});

afterEach(async () => {
  await act(async () => {
    root.unmount();
    await Promise.resolve();
  });
  container.remove();
});

async function render(
  persisted: HomeOnboardingSuggestionsPreferences = persistedState(),
  selectedRoles: readonly ProfileRoleId[] | null = null,
): Promise<void> {
  await act(async () => {
    root.render(
      createElement(HomeOnboardingSuggestions, {
        persisted,
        onUpdatePersisted,
        onInjectPrompt,
        selectedRoles,
        onChangeRoles,
      }),
    );
    await Promise.resolve();
  });
}

function query(testId: string): HTMLElement | null {
  return document.body.querySelector(`[data-testid="${testId}"]`);
}

/** The step's Next is the plain forward arrow relabelled, not a CTA. */
function expectForwardArrowRelabelledNext(next: HTMLElement | null): void {
  expect(next).not.toBeNull();
  expect(next?.getAttribute('aria-label')).toBe('Next');
  expect(next?.getAttribute('title')).toBe('Next');
  expect(next?.getAttribute('data-checklist-navigation')).toBe('true');
  expect(next?.getAttribute('data-checklist-next')).toBe('true');
  expect(next?.hasAttribute('data-checklist-dismiss')).toBe(false);
  expect(next?.querySelector('svg')).not.toBeNull();
  expect(next?.textContent?.trim()).toBe('');
  expect(next?.className).not.toContain('bg-accent');
}

/** Applies the last onUpdatePersisted updater to a base state. */
function lastUpdateApplied(
  base: HomeOnboardingSuggestionsPreferences,
): HomeOnboardingSuggestionsPreferences {
  const calls = onUpdatePersisted.mock.calls;
  const updater = calls[calls.length - 1][0];
  return updater(base);
}

describe('HomeOnboardingSuggestions', () => {
  it('opens the existing import flow from one descriptive action row', async () => {
    Object.defineProperty(window, 'api', {
      configurable: true,
      value: {
        ...window.api,
        externalProjects: {
          readProviderPresence: jest
            .fn()
            .mockResolvedValue({ providerStoresPresent: true }),
        },
      },
    });
    useImportProjectsModalStore.getState().close();
    await render(providersDone());
    const row = query('home-onboarding-suggestion-import-projects');
    expect(row?.querySelector('h2')?.textContent).toContain('Getting started');
    const cta = query('home-onboarding-suggestion-cta-import-projects');
    expect(cta?.textContent).toBe(
      'Import chats and projects from Claude and Codex',
    );
    await act(async () => {
      cta?.click();
      await Promise.resolve();
    });
    expect(useImportProjectsModalStore.getState().target).toEqual({
      source: 'checklist',
    });
    useImportProjectsModalStore.getState().close();
  });

  describe('Cursor rules entry (CAN-2053)', () => {
    function withCursorRulesPresence(
      presence: jest.Mock,
      savePreferences: jest.Mock = jest.fn().mockResolvedValue(undefined),
    ): void {
      Object.defineProperty(window, 'api', {
        configurable: true,
        value: {
          ...window.api,
          savePreferences,
          editorSetup: { presence },
        },
      });
    }

    async function flushProbes(): Promise<void> {
      for (let index = 0; index < 5; index += 1) {
        await act(async () => {
          await Promise.resolve();
        });
      }
    }

    it('stays hidden when no code project has Cursor rules', async () => {
      state.projects = [{ id: 'p1', type: 'project', name: 'canopy' }];
      const presence = jest
        .fn()
        .mockResolvedValue({ cursorRulesPresent: false });
      withCursorRulesPresence(presence);
      await render(providersDone());
      await flushProbes();
      expect(presence).toHaveBeenCalledWith({ workspaceId: 'p1' });
      expect(
        query('home-onboarding-suggestion-import-editor-setup'),
      ).toBeNull();
    });

    it('stays hidden when the presence probe fails', async () => {
      state.projects = [{ id: 'p1', type: 'project', name: 'canopy' }];
      withCursorRulesPresence(jest.fn().mockRejectedValue(new Error('no')));
      await render(providersDone());
      await flushProbes();
      expect(
        query('home-onboarding-suggestion-import-editor-setup'),
      ).toBeNull();
    });

    it('probes code projects newest first and stops at the first with rules', async () => {
      state.projects = [
        { id: 'p1', type: 'project', name: 'oldest' },
        { id: 'c1', type: 'cowork', name: 'cowork' },
        { id: 'p2', type: 'project', name: 'middle' },
        { id: 'p3', type: 'project', name: 'newest' },
      ];
      const presence = jest.fn(({ workspaceId }: { workspaceId: string }) =>
        Promise.resolve({ cursorRulesPresent: workspaceId === 'p2' }),
      );
      withCursorRulesPresence(presence);
      await render(providersDone());
      await flushProbes();
      expect(presence.mock.calls.map(([request]) => request)).toEqual([
        { workspaceId: 'p3' },
        { workspaceId: 'p2' },
      ]);
      expect(
        query('home-onboarding-suggestion-import-editor-setup'),
      ).not.toBeNull();
    });

    it('opens the rules review from the checklist without completing the entry', async () => {
      state.projects = [{ id: 'p1', type: 'project', name: 'canopy' }];
      const savePreferences = jest.fn().mockResolvedValue(undefined);
      withCursorRulesPresence(
        jest.fn().mockResolvedValue({ cursorRulesPresent: true }),
        savePreferences,
      );
      useRepoRulesModalStore.getState().close();
      await render(providersDone());
      await flushProbes();

      const row = query('home-onboarding-suggestion-import-editor-setup');
      expect(row?.querySelector('h2')?.textContent).toContain(
        'Getting started',
      );
      const cta = query('home-onboarding-suggestion-cta-import-editor-setup');
      expect(cta?.textContent).toBe(
        "Bring a project's Cursor rules into new chats. You review each rule first.",
      );
      onUpdatePersisted.mockClear();
      await act(async () => {
        cta?.click();
        await Promise.resolve();
      });
      await flushProbes();

      // No workspace: the review asks which project to use.
      expect(useRepoRulesModalStore.getState().target).toEqual({
        source: 'checklist',
      });
      expect(savePreferences).not.toHaveBeenCalled();
      for (const [updater] of onUpdatePersisted.mock.calls) {
        expect(
          updater(providersDone()).entries['import-editor-setup'],
        ).toBeUndefined();
      }
      useRepoRulesModalStore.getState().close();
    });
  });

  it('waits for project-import eligibility before choosing the first reset step', async () => {
    let resolvePresence: (value: {
      providerStoresPresent: boolean;
    }) => void = () => undefined;
    const presence = new Promise<{ providerStoresPresent: boolean }>(
      (resolve) => {
        resolvePresence = resolve;
      },
    );
    Object.defineProperty(window, 'api', {
      configurable: true,
      value: {
        ...window.api,
        externalProjects: {
          readProviderPresence: (): Promise<{
            providerStoresPresent: boolean;
          }> => presence,
        },
      },
    });

    await render(providersDone());
    expect(query('home-onboarding-suggestion-add-repo')).toBeNull();
    expect(query('home-onboarding-checking-recommendations')).not.toBeNull();

    await act(async () => {
      resolvePresence({ providerStoresPresent: true });
      await Promise.resolve();
    });
    expect(query('home-onboarding-suggestion-import-projects')).not.toBeNull();
    expect(query('home-onboarding-suggestion-add-repo')).toBeNull();
  });

  it('renders the same current queue entry in Home and the new-chat host', async () => {
    const homeHost = document.createElement('div');
    const chatHost = document.createElement('div');
    document.body.append(homeHost, chatHost);
    try {
      await act(async () => {
        root.render(
          createElement(HomeOnboardingSuggestions, {
            persisted: persistedState(),
            onUpdatePersisted,
            onInjectPrompt,
            selectedRoles: null,
            onChangeRoles,
            homeHost,
            chatHost,
          }),
        );
        await Promise.resolve();
      });
      expect(
        homeHost.querySelector(
          '[data-testid="home-onboarding-suggestion-agent-connections"]',
        ),
      ).not.toBeNull();
      expect(
        chatHost.querySelector(
          '[data-testid="home-onboarding-suggestion-agent-connections"]',
        ),
      ).not.toBeNull();
      expect(
        homeHost.querySelector(
          '[data-testid="home-onboarding-checklist-progress"]',
        ),
      ).not.toBeNull();
    } finally {
      act(() => root.render(null));
      homeHost.remove();
      chatHost.remove();
    }
  });

  it('holds the rows while a seeded project’s template is still being read (CAN-3032)', async () => {
    const chatHost = document.createElement('div');
    document.body.append(chatHost);
    state.pluginSuggestionsReady = true;
    useOnboardingSuggestionSurfaces.setState({ chatBlueprintPending: true });
    try {
      await act(async () => {
        root.render(
          createElement(HomeOnboardingSuggestions, {
            persisted: persistedState(),
            onUpdatePersisted,
            onInjectPrompt,
            selectedRoles: null,
            onChangeRoles,
            chatHost,
          }),
        );
        await Promise.resolve();
      });
      expect(
        chatHost.querySelector(
          '[data-testid="home-onboarding-checking-recommendations"]',
        ),
      ).not.toBeNull();
      expect(
        chatHost.querySelector(
          '[data-testid="home-onboarding-suggestion-agent-connections"]',
        ),
      ).toBeNull();
      expect(useOnboardingSuggestionSurfaces.getState().queueStatus).toBe(
        'loading',
      );
      await act(async () => {
        useOnboardingSuggestionSurfaces.setState({
          chatBlueprintPending: false,
        });
        await Promise.resolve();
      });
      expect(
        chatHost.querySelector(
          '[data-testid="home-onboarding-suggestion-agent-connections"]',
        ),
      ).not.toBeNull();
    } finally {
      act(() => root.render(null));
      chatHost.remove();
    }
  });

  it('holds the rows until the plugin source settles for a template context (CAN-3032)', async () => {
    const chatHost = document.createElement('div');
    document.body.append(chatHost);
    state.pluginSuggestionsReady = false;
    useOnboardingSuggestionSurfaces.setState({
      chatBlueprint: {
        projectId: 'marketing-1',
        externalId: '11111111-1111-4111-8111-111111111111',
        name: 'Marketing',
        pluginRefs: [BUILTIN_GIT_REF],
        starterPrompts: [{ id: 'ws-1', text: 'Draft a launch announcement' }],
        projectSelections: null,
      },
    });
    try {
      await act(async () => {
        root.render(
          createElement(HomeOnboardingSuggestions, {
            persisted: persistedState(),
            onUpdatePersisted,
            onInjectPrompt,
            selectedRoles: null,
            onChangeRoles,
            chatHost,
          }),
        );
        await Promise.resolve();
      });
      // Without the plugin rows the prompts would lead, then be pushed down
      // once the catalog answers; hold instead.
      expect(
        chatHost.querySelector(
          '[data-testid="home-onboarding-checking-recommendations"]',
        ),
      ).not.toBeNull();
      expect(
        chatHost.querySelector(
          '[data-testid="home-onboarding-suggestion-blueprint:marketing-1:prompt:ws-1"]',
        ),
      ).toBeNull();
    } finally {
      act(() => root.render(null));
      chatHost.remove();
    }
  });

  it('draws the template rows once the plugin-source hold expires (CAN-3032)', async () => {
    jest.useFakeTimers();
    const chatHost = document.createElement('div');
    document.body.append(chatHost);
    state.pluginSuggestionsReady = false;
    useOnboardingSuggestionSurfaces.setState({
      chatBlueprint: {
        projectId: 'marketing-1',
        externalId: '11111111-1111-4111-8111-111111111111',
        name: 'Marketing',
        pluginRefs: [],
        starterPrompts: [{ id: 'ws-1', text: 'Draft a launch announcement' }],
        projectSelections: null,
      },
    });
    try {
      await act(async () => {
        root.render(
          createElement(HomeOnboardingSuggestions, {
            persisted: persistedState(),
            onUpdatePersisted,
            onInjectPrompt,
            selectedRoles: null,
            onChangeRoles,
            chatHost,
          }),
        );
        await Promise.resolve();
      });
      expect(
        chatHost.querySelector(
          '[data-testid="home-onboarding-checking-recommendations"]',
        ),
      ).not.toBeNull();
      await act(async () => {
        jest.advanceTimersByTime(3_000);
        await Promise.resolve();
      });
      // A hung probe must not hide the checklist: the prompt rows draw.
      expect(
        chatHost.querySelector(
          '[data-testid="home-onboarding-suggestion-blueprint:marketing-1:prompt:ws-1"]',
        ),
      ).not.toBeNull();
    } finally {
      act(() => root.render(null));
      chatHost.remove();
      jest.useRealTimers();
    }
  });

  it('keeps a template prompt in its project chat from the sidebar pill (CAN-3032)', async () => {
    const chatHost = document.createElement('div');
    const sidebarHost = document.createElement('div');
    document.body.append(chatHost, sidebarHost);
    const received: unknown[] = [];
    const receive = (event: Event): void => {
      received.push((event as CustomEvent).detail);
    };
    document.addEventListener('canopy:insert-chat-text', receive);
    state.pluginSuggestionsReady = true;
    useOnboardingSuggestionSurfaces.setState({
      chatPromptTargetId: 'marketing-tab',
      chatBlueprint: {
        projectId: 'marketing-1',
        externalId: '11111111-1111-4111-8111-111111111111',
        name: 'Marketing',
        pluginRefs: [],
        starterPrompts: [{ id: 'ws-1', text: 'Draft a launch announcement' }],
        projectSelections: null,
      },
    });
    try {
      await act(async () => {
        root.render(
          createElement(HomeOnboardingSuggestions, {
            persisted: persistedState(),
            onUpdatePersisted,
            onInjectPrompt,
            selectedRoles: null,
            onChangeRoles,
            chatHost,
            sidebarHost,
          }),
        );
        await Promise.resolve();
      });
      expect(
        sidebarHost.querySelector(
          '[data-testid="sidebar-onboarding-suggestion-title"]',
        )?.textContent,
      ).toBe('Try a Marketing prompt');
      await act(async () => {
        sidebarHost
          .querySelector<HTMLButtonElement>(
            '[data-testid="sidebar-onboarding-suggestion-cta"]',
          )
          ?.click();
        await Promise.resolve();
      });
      expect(received).toEqual([
        { text: 'Draft a launch announcement', targetTabId: 'marketing-tab' },
      ]);
      expect(onInjectPrompt).not.toHaveBeenCalled();
      expect(mockArmOnboardingSuggestion).toHaveBeenCalledWith(
        'blueprint:marketing-1:prompt:ws-1',
        { chatId: 'marketing-tab' },
      );
    } finally {
      document.removeEventListener('canopy:insert-chat-text', receive);
      act(() => root.render(null));
      chatHost.remove();
      sidebarHost.remove();
    }
  });

  it('puts the template heading on the first grouped prompt row only (CAN-3032)', async () => {
    const chatHost = document.createElement('div');
    document.body.append(chatHost);
    state.pluginSuggestionsReady = true;
    useOnboardingSuggestionSurfaces.setState({
      chatBlueprint: {
        projectId: 'writing-1',
        externalId: '22222222-2222-4222-8222-222222222222',
        name: 'Writing',
        pluginRefs: [],
        starterPrompts: [
          { id: 'ws-1', text: 'Help me outline and draft this piece.' },
          { id: 'ws-2', text: 'Edit this draft for clarity and flow.' },
          { id: 'ws-3', text: 'Identify this sample’s voice and apply it.' },
        ],
        projectSelections: null,
      },
    });
    try {
      await act(async () => {
        root.render(
          createElement(HomeOnboardingSuggestions, {
            persisted: persistedState(),
            onUpdatePersisted,
            onInjectPrompt,
            selectedRoles: null,
            onChangeRoles,
            chatHost,
          }),
        );
        await Promise.resolve();
      });
      const rows = ['ws-1', 'ws-2', 'ws-3'].map((id) =>
        chatHost.querySelector(
          `[data-testid="home-onboarding-suggestion-blueprint:writing-1:prompt:${id}"]`,
        ),
      );
      expect(rows.every((row) => row !== null)).toBe(true);
      expect(rows[0]?.querySelector('h2')?.textContent).toContain(
        'Get started with Writing',
      );
      expect(rows[1]?.querySelector('h2')).toBeNull();
      expect(rows[2]?.querySelector('h2')).toBeNull();
      // One heading and one progress label for the window.
      expect(chatHost.querySelectorAll('h2').length).toBe(1);
      expect(
        chatHost.querySelectorAll(
          '[data-testid="home-onboarding-checklist-progress"]',
        ).length,
      ).toBe(1);
    } finally {
      act(() => root.render(null));
      chatHost.remove();
    }
  });

  it('moves through a template window as one step (CAN-3032)', async () => {
    // A local run showed next dismissing only the first prompt (the other
    // two came back as the "next" step) and back returning to one prompt.
    // The window's rows are one step: next leaves them all, back returns to
    // all of them, and the counter counts them once.
    const chatHost = document.createElement('div');
    document.body.append(chatHost);
    state.pluginSuggestionsReady = true;
    const draw = async (
      persisted: HomeOnboardingSuggestionsPreferences,
    ): Promise<void> => {
      await act(async () => {
        root.render(
          createElement(HomeOnboardingSuggestions, {
            persisted,
            onUpdatePersisted,
            onInjectPrompt,
            selectedRoles: null,
            onChangeRoles,
            chatHost,
          }),
        );
        await Promise.resolve();
      });
    };
    const row = (id: string): Element | null =>
      chatHost.querySelector(
        `[data-testid="home-onboarding-suggestion-blueprint:ops-1:prompt:${id}"]`,
      );
    const progress = (): string | null | undefined =>
      chatHost.querySelector(
        '[data-testid="home-onboarding-checklist-progress"]',
      )?.textContent;
    const click = async (element: HTMLElement | null): Promise<void> => {
      if (!element) throw new Error('Expected the control to render');
      await act(async () => {
        element.click();
        await Promise.resolve();
      });
    };
    const prompts = ['ws-1', 'ws-2', 'ws-3'];
    try {
      const initial = persistedState();
      await draw(initial);
      const generalTotal = Number(progress()?.split('/')[1]);
      expect(generalTotal).toBeGreaterThan(0);

      act(() =>
        useOnboardingSuggestionSurfaces.setState({
          chatBlueprint: {
            projectId: 'ops-1',
            externalId: '44444444-4444-4444-8444-444444444444',
            name: 'Operations',
            pluginRefs: [],
            starterPrompts: [
              { id: 'ws-1', text: 'Draft a runbook for this process.' },
              { id: 'ws-2', text: 'Create a runbook with checks.' },
              { id: 'ws-3', text: 'Find bottlenecks in this workflow.' },
            ],
            projectSelections: null,
          },
        }),
      );
      await draw(initial);
      expect(prompts.every((id) => row(id) !== null)).toBe(true);
      // The three prompts add one step, with one set of arrows.
      expect(progress()).toBe(`1/${generalTotal + 1}`);
      expect(
        row('ws-2')?.querySelectorAll('[data-checklist-navigation]').length,
      ).toBe(0);
      expect(
        row('ws-3')?.querySelectorAll('[data-checklist-navigation]').length,
      ).toBe(0);
      expect(
        chatHost.querySelectorAll('[data-checklist-navigation]').length,
      ).toBe(2);

      // Next skips the whole step in one write.
      await click(
        chatHost.querySelector<HTMLElement>(
          '[data-testid="home-onboarding-suggestion-dismiss-blueprint:ops-1:prompt:ws-1"]',
        ),
      );
      expect(onUpdatePersisted).toHaveBeenCalledTimes(1);
      const skipped = lastUpdateApplied(initial);
      for (const id of prompts) {
        expect(
          typeof skipped.entries[`blueprint:ops-1:prompt:${id}`]?.dismissedAt,
        ).toBe('string');
      }
      await draw(skipped);
      expect(prompts.every((id) => row(id) === null)).toBe(true);
      expect(progress()).toBe(`2/${generalTotal + 1}`);

      // Back returns to all of the step's prompts.
      await click(
        chatHost.querySelector<HTMLElement>('[data-testid$="-previous"]'),
      );
      expect(prompts.every((id) => row(id) !== null)).toBe(true);
      expect(progress()).toBe(`1/${generalTotal + 1}`);
      expect(
        chatHost.querySelectorAll('[data-checklist-navigation]').length,
      ).toBe(2);

      // Next from the revisited step returns to where the user was without
      // writing anything.
      await click(
        chatHost.querySelector<HTMLElement>(
          '[data-testid="home-onboarding-suggestion-dismiss-blueprint:ops-1:prompt:ws-1"]',
        ),
      );
      expect(onUpdatePersisted).toHaveBeenCalledTimes(1);
      expect(prompts.every((id) => row(id) === null)).toBe(true);
      expect(progress()).toBe(`2/${generalTotal + 1}`);
    } finally {
      act(() => root.render(null));
      chatHost.remove();
    }
  });

  describe('template steps (CAN-3032)', () => {
    const OPS_PROMPTS = [
      { id: 'ws-1', text: 'Draft a runbook for this process.' },
      { id: 'ws-2', text: 'Create a runbook with checks.' },
      { id: 'ws-3', text: 'Find bottlenecks in this workflow.' },
    ];
    const opsBlueprint = (
      starterPrompts = OPS_PROMPTS,
    ): ReturnType<
      typeof useOnboardingSuggestionSurfaces.getState
    >['chatBlueprint'] => ({
      projectId: 'ops-1',
      externalId: '44444444-4444-4444-8444-444444444444',
      name: 'Operations',
      pluginRefs: [],
      starterPrompts,
      projectSelections: null,
    });
    const templatePlugin = (
      name: string,
      displayName: string,
    ): OnboardingPluginSuggestionInput => ({
      key: `builtin/${name}`,
      name,
      displayName,
      description: `${displayName} tools`,
      promptText: `Try ${displayName}`,
      promptTexts: [`Try ${displayName}`],
      enabled: false,
      enableKeys: [`builtin/${name}`],
      searchQuery: name,
    });
    let chatHost: HTMLDivElement;
    let sidebarHost: HTMLDivElement;
    beforeEach(() => {
      chatHost = document.createElement('div');
      sidebarHost = document.createElement('div');
      document.body.append(chatHost, sidebarHost);
      state.pluginSuggestionsReady = true;
    });
    afterEach(() => {
      act(() => root.render(null));
      chatHost.remove();
      sidebarHost.remove();
    });
    const draw = async (
      persisted: HomeOnboardingSuggestionsPreferences,
    ): Promise<void> => {
      await act(async () => {
        root.render(
          createElement(HomeOnboardingSuggestions, {
            persisted,
            onUpdatePersisted,
            onInjectPrompt,
            selectedRoles: null,
            onChangeRoles,
            chatHost,
            sidebarHost,
          }),
        );
        await Promise.resolve();
      });
    };
    const find = (testId: string): HTMLElement | null =>
      document.body.querySelector<HTMLElement>(`[data-testid="${testId}"]`);
    const click = async (element: HTMLElement | null): Promise<void> => {
      if (!element) throw new Error('Expected the control to render');
      await act(async () => {
        element.click();
        await Promise.resolve();
      });
    };
    const promptRow = (id: string): HTMLElement | null =>
      find(`home-onboarding-suggestion-blueprint:ops-1:prompt:${id}`);
    const progress = (): string | null | undefined =>
      chatHost.querySelector(
        '[data-testid="home-onboarding-checklist-progress"]',
      )?.textContent;

    it('names the whole step on its skip arrows and records one dismissal', async () => {
      useOnboardingSuggestionSurfaces.setState({
        chatBlueprint: opsBlueprint(),
      });
      await draw(persistedState());
      const headingSkip = find(
        'home-onboarding-suggestion-dismiss-blueprint:ops-1:prompt:ws-1',
      );
      // The arrow skips all three prompts, so its name says so.
      expect(headingSkip?.getAttribute('aria-label')).toBe(
        'Skip Operations prompts',
      );
      // The sidebar card's × skips the same rows, so it carries the same name.
      expect(find('sidebar-onboarding-skip')?.getAttribute('aria-label')).toBe(
        'Skip Operations prompts',
      );

      await click(headingSkip);
      // One click, one dismissal event, however many rows it skipped.
      expect(trackOnboardingSuggestionDismiss).toHaveBeenCalledTimes(1);
      expect(trackOnboardingSuggestionDismiss).toHaveBeenCalledWith(
        'blueprint:ops-1:prompt:ws-1',
      );
    });

    it('names the row when only one row of the step remains', async () => {
      useOnboardingSuggestionSurfaces.setState({
        chatBlueprint: opsBlueprint(),
      });
      await draw(
        persistedState({
          'blueprint:ops-1:prompt:ws-1': { completedAt: 'x' },
          'blueprint:ops-1:prompt:ws-2': { completedAt: 'x' },
        }),
      );
      expect(
        find(
          'home-onboarding-suggestion-dismiss-blueprint:ops-1:prompt:ws-3',
        )?.getAttribute('aria-label'),
      ).toBe('Skip Find bottlenecks in this workflow.');
    });

    it('skips only the rows a partly completed step still shows', async () => {
      useOnboardingSuggestionSurfaces.setState({
        chatBlueprint: opsBlueprint(),
      });
      const partial = persistedState({
        'blueprint:ops-1:prompt:ws-2': { completedAt: 'x' },
      });
      await draw(partial);
      expect(promptRow('ws-1')).not.toBeNull();
      expect(promptRow('ws-2')).toBeNull();
      expect(promptRow('ws-3')).not.toBeNull();
      await click(
        find('home-onboarding-suggestion-dismiss-blueprint:ops-1:prompt:ws-1'),
      );
      expect(onUpdatePersisted).toHaveBeenCalledTimes(1);
      const next = lastUpdateApplied(partial);
      expect(
        typeof next.entries['blueprint:ops-1:prompt:ws-1']?.dismissedAt,
      ).toBe('string');
      expect(
        typeof next.entries['blueprint:ops-1:prompt:ws-3']?.dismissedAt,
      ).toBe('string');
      // The prompt already tried stays completed, never dismissed.
      expect(next.entries['blueprint:ops-1:prompt:ws-2']).toEqual({
        completedAt: 'x',
      });
    });

    it('steps back and forward across revisited multi-row steps', async () => {
      blueprintSuggestions = [
        templatePlugin('builtin-git', 'Git'),
        templatePlugin('builtin-gh', 'GitHub CLI'),
      ];
      useOnboardingSuggestionSurfaces.setState({
        chatBlueprint: opsBlueprint(OPS_PROMPTS.slice(0, 2)),
      });
      const pluginRow = (name: string): HTMLElement | null =>
        find(`home-onboarding-suggestion-blueprint:ops-1:plugin:${name}`);
      // Both template steps skipped earlier; the general queue is live.
      await draw(
        persistedState({
          'blueprint:ops-1:plugin:builtin-git': { dismissedAt: 'x' },
          'blueprint:ops-1:plugin:builtin-gh': { dismissedAt: 'x' },
          'blueprint:ops-1:prompt:ws-1': { dismissedAt: 'x' },
          'blueprint:ops-1:prompt:ws-2': { dismissedAt: 'x' },
        }),
      );
      const total = progress()?.split('/')[1];
      expect(progress()).toBe(`3/${total}`);
      const writes = onUpdatePersisted.mock.calls.length;

      await click(chatHost.querySelector('[data-testid$="-previous"]'));
      expect(promptRow('ws-1')).not.toBeNull();
      expect(promptRow('ws-2')).not.toBeNull();
      expect(progress()).toBe(`2/${total}`);

      await click(chatHost.querySelector('[data-testid$="-previous"]'));
      expect(pluginRow('builtin-git')).not.toBeNull();
      expect(pluginRow('builtin-gh')).not.toBeNull();
      expect(promptRow('ws-1')).toBeNull();
      expect(progress()).toBe(`1/${total}`);

      // Next from a revisited step lands on the next revisited step whole.
      await click(
        find(
          'home-onboarding-suggestion-dismiss-blueprint:ops-1:plugin:builtin-git',
        ),
      );
      expect(pluginRow('builtin-git')).toBeNull();
      expect(promptRow('ws-1')).not.toBeNull();
      expect(promptRow('ws-2')).not.toBeNull();
      expect(progress()).toBe(`2/${total}`);

      await click(
        find('home-onboarding-suggestion-dismiss-blueprint:ops-1:prompt:ws-1'),
      );
      expect(promptRow('ws-1')).toBeNull();
      expect(progress()).toBe(`3/${total}`);
      // Revisiting writes nothing.
      expect(onUpdatePersisted).toHaveBeenCalledTimes(writes);
    });
  });

  it('tailors the new-chat checklist to the active project template (CAN-3032)', async () => {
    const homeHost = document.createElement('div');
    const chatHost = document.createElement('div');
    document.body.append(homeHost, chatHost);
    state.pluginSuggestionsReady = true;
    blueprintSuggestions = [
      {
        key: 'builtin/builtin-git',
        name: 'builtin-git',
        displayName: 'Git',
        description: 'Git tools',
        promptText: 'Try Git',
        promptTexts: ['Try Git'],
        enabled: false,
        enableKeys: ['builtin/builtin-git'],
        searchQuery: 'builtin-git',
      },
    ];
    useOnboardingSuggestionSurfaces.setState({
      chatPromptTargetId: 'marketing-tab',
      chatBlueprint: {
        projectId: 'marketing-1',
        externalId: '11111111-1111-4111-8111-111111111111',
        name: 'Marketing',
        pluginRefs: [BUILTIN_GIT_REF],
        starterPrompts: [{ id: 'ws-1', text: 'Draft a launch announcement' }],
        projectSelections: null,
      },
    });
    try {
      await act(async () => {
        root.render(
          createElement(HomeOnboardingSuggestions, {
            persisted: persistedState(),
            onUpdatePersisted,
            onInjectPrompt,
            selectedRoles: null,
            onChangeRoles,
            homeHost,
            chatHost,
          }),
        );
        await Promise.resolve();
      });
      expect(lastPluginSuggestionOptions).toEqual({
        blueprintPluginRefs: [BUILTIN_GIT_REF],
        projectSelections: null,
      });
      const row = chatHost.querySelector(
        '[data-testid="home-onboarding-suggestion-blueprint:marketing-1:plugin:builtin-git"]',
      );
      expect(row).not.toBeNull();
      expect(row?.querySelector('h2')?.textContent).toContain(
        'Get started with Marketing',
      );
      expect(
        chatHost.querySelector(
          '[data-testid="home-onboarding-suggestion-agent-connections"]',
        ),
      ).toBeNull();
      const cta = chatHost.querySelector<HTMLButtonElement>(
        '[data-testid="home-onboarding-suggestion-cta-plugin-add-builtin/builtin-git"]',
      );
      expect(cta?.getAttribute('aria-label')).toBe('Add Git');
      await act(async () => {
        cta?.click();
        await Promise.resolve();
      });
      expect(installOnboardingPlugin).toHaveBeenCalledWith([
        'builtin/builtin-git',
      ]);

      // Leaving the project's new chat restores the general checklist.
      await act(async () => {
        useOnboardingSuggestionSurfaces.setState({ chatBlueprint: null });
        await Promise.resolve();
      });
      expect(
        homeHost.querySelector(
          '[data-testid="home-onboarding-suggestion-agent-connections"]',
        ),
      ).not.toBeNull();
      expect(
        homeHost.querySelector(
          '[data-testid="home-onboarding-suggestion-blueprint:marketing-1:plugin:builtin-git"]',
        ),
      ).toBeNull();
    } finally {
      act(() => root.render(null));
      homeHost.remove();
      chatHost.remove();
    }
  });

  it.each([
    [false, false],
    [false, true],
    [true, false],
    [true, true],
  ])(
    'discovers Cursor onboarding only when master=%s and release=%s',
    async (enabled, released) => {
      const previous = useFeatureFlagsStore.getState().snapshot;
      useFeatureFlagsStore.getState().setSnapshot({
        ...previous,
        values: {
          ...previous.values,
          'canopy-desktop-cursor-harness': enabled,
          'canopy-desktop-cursor-harness-released': released,
        },
      });
      try {
        await render(stepReady('agent-connections'));
        const cursor = query('home-onboarding-suggestion-connect-cursor');
        if (enabled && released) {
          expect(cursor).not.toBeNull();
          act(() => cursor?.click());
          expect(mockOpenSettings).toHaveBeenCalledWith('account');
        } else {
          expect(cursor).toBeNull();
        }
      } finally {
        act(() => useFeatureFlagsStore.getState().setSnapshot(previous));
      }
    },
  );

  it('lets a released Cursor connection complete the harness step', async () => {
    mockCursorAvailable = true;
    const flags = useFeatureFlagsStore.getState();
    const previous = flags.snapshot;
    flags.setSnapshot({
      ...previous,
      values: {
        ...previous.values,
        'canopy-desktop-cursor-harness': true,
        'canopy-desktop-cursor-harness-released': true,
      },
    });
    try {
      await render(stepReady('agent-connections'));
      const cursor = query('home-onboarding-suggestion-connect-cursor');
      expect(cursor?.getAttribute('aria-label')).toBe('Cursor connected');
      expect(query('home-onboarding-agent-connections-next')).not.toBeNull();
      act(() => cursor?.click());
      expect(mockOpenSettings).not.toHaveBeenCalled();
      expect(
        useOnboardingSuggestionSurfaces.getState().modelPickerHighlightTarget,
      ).toEqual({ scope: 'home' });
    } finally {
      act(() => flags.setSnapshot(previous));
    }
  });

  it('keeps every agent option visible when one is already connected', async () => {
    state.claude = connectedAuth();
    await render(stepReady('agent-connections'));
    const heading = query(
      'home-onboarding-suggestion-agent-connections',
    )?.querySelector('h2');
    expect(heading?.textContent).toContain('Add your AI providers');
    expect(heading?.parentElement?.className).toContain('px-2');
    expect(heading?.parentElement?.className).not.toContain('px-4');
    const subtitle = query(
      'home-onboarding-agent-connections-subtitle',
    )?.textContent;
    expect(subtitle).toBe(
      `Bring your own subscription or use your ${brandText.appName} account.`,
    );
    expect(subtitle).not.toContain('free AI credits');
    expect(subtitle).not.toContain('Codex fork');
    expect(
      query('home-onboarding-suggestion-agent-connections')?.dataset.step,
    ).toBe('connect-agents');
    expect(
      query('home-onboarding-suggestion-connect-claude')?.getAttribute(
        'aria-label',
      ),
    ).toBe('Claude connected');
    expect(
      query('home-onboarding-suggestion-connect-codex')?.getAttribute(
        'aria-label',
      ),
    ).toBe('Connect Codex');
    expect(
      query('home-onboarding-suggestion-connect-ollama')?.getAttribute(
        'aria-label',
      ),
    ).toBe('Open Ollama settings');
    expect(
      query(
        'home-onboarding-agent-connections',
      )?.firstElementChild?.getAttribute('data-testid'),
    ).toBe('home-onboarding-suggestion-connect-unstoppable');
    act(() => query('home-onboarding-suggestion-connect-unstoppable')?.click());
    expect(
      useOnboardingSuggestionSurfaces.getState().modelPickerHighlightTarget,
    ).toEqual({ scope: 'home' });
    act(() => query('home-onboarding-suggestion-connect-claude')?.click());
    expect(
      useOnboardingSuggestionSurfaces.getState().modelPickerHighlightTarget,
    ).toEqual({ scope: 'home' });
    expect(mockAuthLoginModal).not.toHaveBeenCalled();
  });

  it('opens provider auth in a Browser panel beside the active new task', async () => {
    state.claude = {
      authenticated: false,
      accountLabel: null,
      detail: null,
      error: null,
    };
    useOnboardingSuggestionSurfaces.setState({
      chatBrowserTarget: {
        projectId: 'project-1',
        worktreeId: 'worktree-1',
        chatId: 'chat-1',
      },
    });
    await render(stepReady('agent-connections'));
    act(() => query('home-onboarding-suggestion-connect-claude')?.click());
    const modalProps = mockAuthLoginModal.mock.calls.at(-1)?.[0];
    const url = 'https://claude.com/cai/oauth/authorize?state=x';
    await act(async () => {
      modalProps?.onAuthorizationUrl?.(url);
      await Promise.resolve();
    });
    expect(mockOpenOnboardingAuthorizationUrl).toHaveBeenCalledWith(
      {
        projectId: 'project-1',
        worktreeId: 'worktree-1',
        chatId: 'chat-1',
      },
      url,
    );
  });

  // A project that was already there has nothing for the user to do and
  // nothing they did, so it takes no number: the checklist leads with the
  // first step that asks something of them.
  it('leaves a project that was already there out of the numbering, unlike one the user resolved', async () => {
    const counter = (): [number, number] => {
      const text = query('home-onboarding-checklist-progress')?.textContent;
      const match = /^(\d+)\/(\d+)$/.exec(text ?? '');
      if (!match) throw new Error(`Expected a counter, got ${text}`);
      return [Number(match[1]), Number(match[2])];
    };
    state.projects = [{ id: 'p1', type: 'project', name: 'canopy' }];
    await render(persistedState(), ['software-engineer']);
    expect(
      query('home-onboarding-suggestion-agent-connections'),
    ).not.toBeNull();
    const [liveStep, total] = counter();
    // The same project, resolved by the user (added from the step or
    // skipped), is a done step numbered ahead of the live one.
    await render(persistedState({ 'add-repo': { completedAt: 'x' } }), [
      'software-engineer',
    ]);
    expect(counter()).toEqual([liveStep + 1, total + 1]);
    // Back never lands on the project step the user never saw.
    await render(persistedState(), ['software-engineer']);
    const previous = query(
      'home-onboarding-suggestion-dismiss-agent-connections-previous',
    );
    if (previous && !previous.hasAttribute('disabled')) {
      act(() => previous.click());
      expect(query('home-onboarding-suggestion-add-repo')).toBeNull();
    }
  });

  // A project the user adds while the step is live is that step's
  // completion: it is recorded, so it keeps its number like any other done
  // step and the counter still reads "done + 1".
  it('records the project step as completed when a project appears while it is live', async () => {
    state.projects = [];
    await render(stepReady('add-repo'), ['software-engineer']);
    expect(query('home-onboarding-suggestion-add-repo')).not.toBeNull();
    const before = query('home-onboarding-checklist-progress')?.textContent;
    const writes = onUpdatePersisted.mock.calls.length;
    state.projects = [{ id: 'p1', type: 'project', name: 'canopy' }];
    await render(stepReady('add-repo'), ['software-engineer']);
    expect(onUpdatePersisted.mock.calls.length).toBeGreaterThan(writes);
    const recorded = lastUpdateApplied(stepReady('add-repo'));
    expect(recorded.entries['add-repo']?.completedAt).toBeDefined();
    // Recorded, the step keeps its number: the next step reads one higher
    // (the total may grow too, as repository lessons join the count).
    await render(recorded, ['software-engineer']);
    expect(query('home-onboarding-suggestion-github')).not.toBeNull();
    const match = /^(\d+)\/(\d+)$/.exec(before ?? '');
    if (!match) throw new Error(`Expected a counter, got ${before}`);
    expect(query('home-onboarding-checklist-progress')?.textContent).toMatch(
      new RegExp(`^${Number(match[1]) + 1}/\\d+$`),
    );
  });

  // Done steps are numbered first (the fixture's completed examples preview
  // included), so the live step reads "done + 1" and advanced
  // prompts are never counted.
  it('numbers the live step as done plus one, not by its list position', async () => {
    state.projects = [{ id: 'p1', type: 'project', name: 'canopy' }];
    await render(stepReady('plan-mode'), ['software-engineer']);
    expect(query('home-onboarding-checklist-progress')?.textContent).toBe(
      '5/6',
    );
    const progress = query('home-onboarding-checklist-progress');
    const previous = query(
      'home-onboarding-suggestion-dismiss-plan-mode-previous',
    );
    if (!progress || !previous?.parentElement) {
      throw new Error('Expected checklist progress and navigation controls');
    }
    const navigation = previous.parentElement;
    const trailing = progress.parentElement;
    expect(trailing).toBe(navigation.parentElement);
    if (!trailing) throw new Error('Expected checklist trailing controls');
    expect(Array.from(trailing.children).indexOf(progress)).toBeLessThan(
      Array.from(trailing.children).indexOf(navigation),
    );

    // Back walks the numbers down by one through the done steps.
    act(() =>
      query('home-onboarding-suggestion-dismiss-plan-mode-previous')?.click(),
    );
    expect(query('home-onboarding-checklist-progress')?.textContent).toBe(
      '4/6',
    );
    expect(
      query('home-onboarding-suggestion-plugin-examples-preview'),
    ).not.toBeNull();
  });

  // Done steps are numbered first and remaining steps after, so the counter
  // reads "done + 1" on the live step and never jumps a number when a later
  // step was already finished elsewhere. Back walks the numbers down by one.
  it('never skips a number when a later step is already done', async () => {
    state.projects = [{ id: 'p1', type: 'project', name: 'canopy' }];
    await render(
      stepReady('github', {
        'focus-shortcut': { completedAt: 'x' },
        // A legacy notifications record neither renders nor counts.
        notifications: { completedAt: 'x' },
      }),
      ['software-engineer'],
    );
    expect(query('home-onboarding-checklist-progress')?.textContent).toBe(
      '4/5',
    );
    act(() =>
      query('home-onboarding-suggestion-dismiss-github-previous')?.click(),
    );
    expect(query('home-onboarding-suggestion-focus-shortcut')).not.toBeNull();
    expect(query('home-onboarding-checklist-progress')?.textContent).toBe(
      '3/5',
    );
    act(() =>
      query(
        'home-onboarding-suggestion-dismiss-focus-shortcut-previous',
      )?.click(),
    );
    expect(query('home-onboarding-suggestion-add-repo')).not.toBeNull();
    expect(query('home-onboarding-checklist-progress')?.textContent).toBe(
      '2/5',
    );
  });

  // Choosing a nontechnical category keeps an existing project's completed
  // step counted while the tools step stays in place.
  it('keeps progress stable when a nontechnical category follows a done project step', async () => {
    state.projects = [{ id: 'p1', type: 'project', name: 'canopy' }];
    await render(providersDone(), null);
    expect(query('home-onboarding-suggestion-github')).not.toBeNull();
    const before = query('home-onboarding-checklist-progress')?.textContent;
    await render(providersDone(), ['designer']);
    expect(query('home-onboarding-suggestion-github')).not.toBeNull();
    expect(query('home-onboarding-checklist-progress')?.textContent).toBe(
      before,
    );
  });

  // The examples preview only exists once a suggested tool is connected and
  // the catalog has settled. Finishing it moves the counter by exactly one.
  it('keeps the examples preview number stable when it completes', async () => {
    state.projects = [{ id: 'p1', type: 'project', name: 'canopy' }];
    state.github = { ...notConnectedGh(), authenticated: true };
    state.pluginSuggestionsReady = true;
    await render(stepReady('plugin-examples-preview'), ['software-engineer']);
    expect(
      query('home-onboarding-suggestion-plugin-examples-preview'),
    ).not.toBeNull();
    expect(query('home-onboarding-checklist-progress')?.textContent).toBe(
      '4/6',
    );
    await render(
      stepReady('plugin-examples-preview', {
        'plugin-examples-preview': { completedAt: 'x' },
      }),
      ['software-engineer'],
    );
    expect(query('home-onboarding-suggestion-plan-mode')).not.toBeNull();
    expect(query('home-onboarding-checklist-progress')?.textContent).toBe(
      '5/6',
    );
  });

  // One resolved earlier stays in the list as a done step from first paint,
  // so the number is right before the catalog settles and does not move
  // when it does.
  it('counts an examples preview resolved earlier from first paint', async () => {
    state.projects = [{ id: 'p1', type: 'project', name: 'canopy' }];
    state.github = { ...notConnectedGh(), authenticated: true };
    state.pluginSuggestionsReady = false;
    const persisted = stepReady('agent-connections', {
      'plugin-examples-preview': { completedAt: 'x' },
    });
    await render(persisted, ['software-engineer']);
    // The fixture's project was already there and the user never resolved
    // the project step, so it takes no number.
    expect(query('home-onboarding-checklist-progress')?.textContent).toBe(
      '2/5',
    );
    state.pluginSuggestionsReady = true;
    await render(persisted, ['software-engineer']);
    expect(
      query('home-onboarding-suggestion-agent-connections'),
    ).not.toBeNull();
    expect(query('home-onboarding-checklist-progress')?.textContent).toBe(
      '2/5',
    );
  });

  // A repository lesson the user acted on keeps counting if the last project
  // is removed later; only lessons the queue deferred or auto-dismissed on
  // its own are left out of the count.
  it('keeps a completed repository lesson counted after the last project is removed', async () => {
    state.projects = [];
    await render(stepReady('focus-shortcut'), ['software-engineer']);
    expect(query('home-onboarding-suggestion-focus-shortcut')).not.toBeNull();
    // Add repo, GitHub, examples preview, providers, and plan mode stay
    // counted after the last repository is removed.
    expect(query('home-onboarding-checklist-progress')?.textContent).toBe(
      '6/6',
    );
  });

  it('offers a repo-free first prompt for a nontechnical role', async () => {
    state.claude = connectedAuth();
    await render(stepReady('plan-mode'), ['student']);
    expect(query('home-onboarding-suggestion-plan-mode')?.dataset.step).toBe(
      'prompt',
    );
    const promptRow = query('home-onboarding-suggestion-cta-prompt');
    expect(promptRow?.textContent?.length).toBeLessThanOrEqual(25);
    act(() => query('home-onboarding-suggestion-cta-prompt')?.click());
    expect(onInjectPrompt).toHaveBeenCalledWith(
      'Help me plan a project I am working on. Ask me about the goal and constraints, then propose milestones, dependencies, and a practical first step.',
    );
    expect(mockSelectWorkspace).not.toHaveBeenCalled();
  });

  it('keeps harness connections in one section without needs-attention labels', async () => {
    const disconnected: AgentProviderAuthStatus = {
      authenticated: false,
      accountLabel: null,
      detail: null,
      error: 'Provider is not authenticated.',
    };
    state.claude = disconnected;
    state.codex = disconnected;
    await render(stepReady('agent-connections'));
    expect(query('home-onboarding-subscription-prompt')).toBeNull();
    act(() =>
      useOnboardingChecklistStore.setState({
        state: {
          items: [{ id: 'start-chat', complete: true }],
          dismissedAt: null,
          snoozedUntil: null,
          providersNotUsed: [],
        },
      }),
    );
    await render(stepReady('agent-connections'));
    expect(query('home-onboarding-subscription-prompt')).toBeNull();
    expect(
      query('home-onboarding-suggestion-agent-connections')?.textContent,
    ).not.toContain('Connect an existing Claude or Codex subscription');
    expect(
      query('home-onboarding-suggestion-connect-claude')?.textContent,
    ).not.toContain('Needs attention');
    expect(
      query('home-onboarding-suggestion-connect-codex')?.textContent,
    ).not.toContain('Needs attention');
  });

  // Project readiness fixes join the queue once every numbered step is done.
  // They are steps of their own, so the counter keeps climbing on each of
  // them instead of repeating the finished total.
  it('numbers project readiness fixes after the last step', async () => {
    const complete = persistedState(
      Object.fromEntries(
        [
          'focus-shortcut',
          'add-repo',
          'github',
          'plugin-examples-preview',
          'agent-connections',
          'plan-mode',
        ].map((id) => [id, { completedAt: 'x' }]),
      ),
    );
    const issue = (
      code: WorkspaceReadinessIssue['code'],
      title: string,
    ): WorkspaceReadinessIssue => ({
      code,
      title,
      message: title,
      repoName: 'Project',
      fixPrompt: `Fix: ${title}`,
    });
    jest.mocked(window.api.getWorkspaceReadiness).mockResolvedValue({
      issues: [
        issue('configure-scripts', 'Add setup and launch scripts'),
        issue('configure-hooks', 'Add hooks'),
      ],
    });
    state.projects = [{ id: 'p1', type: 'project', name: 'Project' }];
    state.github = { ...notConnectedGh(), authenticated: true };
    state.pluginSuggestionsReady = true;
    await render(complete, ['software-engineer']);
    await render(complete, ['software-engineer']);
    expect(
      document.body.querySelector(
        '[data-testid^="home-onboarding-readiness-"]',
      ),
    ).not.toBeNull();
    // Six setup steps are done, so the first fix is step 7 of 8.
    expect(query('home-onboarding-checklist-progress')?.textContent).toBe(
      '7/8',
    );
    const next = document.body.querySelector<HTMLButtonElement>(
      '[data-testid^="home-onboarding-suggestion-dismiss-advanced:readiness:"]:not([data-testid$="-previous"])',
    );
    expect(next).not.toBeNull();
    act(() => next?.click());
    await render(lastUpdateApplied(complete), ['software-engineer']);
    expect(query('home-onboarding-checklist-progress')?.textContent).toBe(
      '8/8',
    );
  });

  it('unlocks advanced prompts only after every activity is complete and sources have settled', async () => {
    const complete = persistedState(
      Object.fromEntries(
        [
          'focus-shortcut',
          'add-repo',
          'github',
          'plugin-examples-preview',
          'agent-connections',
          'plan-mode',
          'linear',
        ].map((id) => [id, { completedAt: 'x' }]),
      ),
    );
    state.projects = [{ id: 'p1', type: 'project', name: 'Project' }];
    state.github = { ...notConnectedGh(), authenticated: true };
    await render(complete, ['software-engineer']);
    expect(query('home-onboarding-advanced-prompts')).toBeNull();
    state.pluginSuggestions = [
      {
        key: 'curated/notion',
        name: 'notion',
        displayName: 'Notion',
        description: 'Notes and docs',
        promptText: 'Summarize recent updates in Notion',
        promptTexts: [
          'Summarize recent updates in Notion',
          'Find decisions in Notion',
          'Draft a project brief from Notion',
        ],
        enabled: true,
        enableKeys: ['curated/notion'],
        searchQuery: 'notion',
      },
    ];
    state.pluginSuggestionsReady = true;
    await render(complete, ['software-engineer']);
    expect(query('home-onboarding-advanced-prompts')).not.toBeNull();
    expect(query('home-onboarding-checklist-progress')).toBeNull();
    expect(
      query('home-onboarding-advanced-prompts')?.querySelector(
        '[data-checklist-navigation="true"]',
      ),
    ).toBeNull();
    expect(
      query('home-onboarding-advanced-prompts')?.textContent,
    ).not.toContain('Getting started');
    expect(
      query('home-onboarding-advanced-prompt-plugin:curated/notion:0')
        ?.querySelector('[data-testid="mcp-server-logo-stub"]')
        ?.getAttribute('data-chrome'),
    ).toBe('transparent');
    act(() => query('home-onboarding-advanced-prompt-github:0')?.click());
    expect(onInjectPrompt).toHaveBeenCalledWith(addRepoTryPrompt('Project'));
    expect(mockArmOnboardingSuggestion).toHaveBeenCalledWith(
      'advanced:github:0',
    );
  });

  it('dismisses an activity and counts it toward progress without completing its setup', async () => {
    const previous = stepReady('github');
    await render(previous, ['software-engineer']);
    act(() => query('home-onboarding-suggestion-dismiss-github')?.click());
    const next = lastUpdateApplied(previous);
    expect(next.entries.github?.dismissedAt).toEqual(expect.any(String));
    expect(next.entries.github?.completedAt).toBeUndefined();
    expect(next.entries['agent-connections']?.completedAt).toBe('x');
    await render(next, ['software-engineer']);
    expect(query('home-onboarding-suggestion-github')).toBeNull();
    expect(query('home-onboarding-checklist-progress')).not.toBeNull();
    expect(query('home-onboarding-advanced-prompts')).toBeNull();
  });

  it('removes a newly resolved step immediately and preserves that result on navigation', async () => {
    await render();
    act(() =>
      query('home-onboarding-suggestion-dismiss-agent-connections')?.click(),
    );
    expect(onUpdatePersisted).toHaveBeenCalled();
    await render(providersDone(), ['software-engineer']);
    expect(query('home-onboarding-suggestion-agent-connections')).toBeNull();
    expect(query('home-onboarding-suggestion-add-repo')).not.toBeNull();
    state.activePage = 'plugins';
    await render(providersDone(), ['software-engineer']);
    state.activePage = 'home';
    await render(providersDone(), ['software-engineer']);
    expect(query('home-onboarding-suggestion-agent-connections')).toBeNull();
  });

  it('ignores a completion arriving from a previous page visit', async () => {
    await render();
    act(() =>
      query('home-onboarding-suggestion-dismiss-agent-connections')?.click(),
    );
    expect(onUpdatePersisted).toHaveBeenCalled();
    state.activePage = 'main';
    await render();
    await render(providersDone(), ['software-engineer']);
    expect(query('home-onboarding-suggestion-agent-connections')).toBeNull();
  });

  it('hides completed activities while keeping their progress', async () => {
    await render(providersDone(), ['software-engineer']);
    expect(query('home-onboarding-suggestion-agent-connections')).toBeNull();
    expect(query('home-onboarding-checklist-progress')).not.toBeNull();
  });

  it('restores a completed activity when it is reset', async () => {
    await render(providersDone(), ['software-engineer']);
    expect(query('home-onboarding-suggestion-agent-connections')).toBeNull();
    await render();
    expect(
      query('home-onboarding-suggestion-dismiss-agent-connections'),
    ).not.toBeNull();
    expect(
      container.querySelectorAll(
        '[data-testid="home-onboarding-suggestion-agent-connections"]',
      ),
    ).toHaveLength(1);
  });

  it('does not replay completions for activities that were not displayed', async () => {
    await render();
    await render(persistedState({ github: { completedAt: 'new' } }));
    expect(query('home-onboarding-suggestion-github')).toBeNull();
    expect(
      query('home-onboarding-suggestion-dismiss-agent-connections'),
    ).not.toBeNull();
  });

  it('asks for categories above the tool tiles instead of as a separate step', async () => {
    state.pluginSuggestionsReady = true;
    await render();
    expect(query('home-onboarding-suggestion-roles')).toBeNull();
    expect(query('home-onboarding-category-software-engineer')).toBeNull();

    await render(stepReady('github'));
    const row = query('home-onboarding-suggestion-github');
    const group = query('home-onboarding-categorys');
    const tools = query('home-onboarding-tool-recommendations');
    if (!row || !group || !tools) throw new Error('tools step parts missing');
    expect(row.contains(group)).toBe(true);
    // The category row sits above the tool tiles, in one line of five.
    expect(
      group.compareDocumentPosition(tools) & Node.DOCUMENT_POSITION_FOLLOWING,
    ).toBeTruthy();
    expect(group.className).toContain('flex-nowrap');
    const labelId = group.getAttribute('aria-labelledby');
    expect(labelId ? document.getElementById(labelId)?.textContent : null).toBe(
      'Pick a category',
    );
    expect(
      Array.from(group.querySelectorAll('button'), (tile) =>
        tile.getAttribute('data-testid'),
      ),
    ).toEqual([
      'home-onboarding-category-software-engineer',
      'home-onboarding-category-product-manager',
      'home-onboarding-category-designer',
      'home-onboarding-category-founder',
      'home-onboarding-category-marketing',
    ]);
    // Category tiles are a size down from the 40px tool tiles.
    expect(query('home-onboarding-category-designer')?.className).not.toContain(
      'min-h-10',
    );
    expect(query('home-onboarding-tool-linear')?.className).toContain(
      'min-h-10',
    );
  });

  it('uses the forward arrow for Next after two tools connect', async () => {
    state.linearAvailable = true;
    state.pluginSuggestions = [
      {
        key: 'curated/slack',
        name: 'slack',
        displayName: 'Slack',
        description: 'Team chat',
        promptText: 'Summarize my unread Slack threads',
        promptTexts: ['Summarize my unread Slack threads'],
        enabled: true,
        enableKeys: ['curated/slack'],
        searchQuery: 'slack',
      },
      {
        key: 'curated/notion',
        name: 'notion',
        displayName: 'Notion',
        description: 'Notes and docs',
        promptText: 'Summarize recent updates in Notion',
        promptTexts: ['Summarize recent updates in Notion'],
        enabled: false,
        enableKeys: ['curated/notion'],
        searchQuery: 'notion',
      },
    ];
    state.pluginSuggestionsReady = true;
    const previous = stepReady('github');
    await render(previous, ['software-engineer']);
    const row = query('home-onboarding-suggestion-github');
    const next = query('home-onboarding-tools-next');
    expectForwardArrowRelabelledNext(next);
    expect(row?.querySelectorAll('[data-checklist-navigation]')).toHaveLength(
      2,
    );
    expect(row?.querySelector('button.bg-accent')).toBeNull();
    act(() => next?.click());
    expect(lastUpdateApplied(previous).entries.github?.dismissedAt).toEqual(
      expect.any(String),
    );
  });

  it('saves each category pick and re-ranks the tool tiles as categories change', async () => {
    state.pluginSuggestionsReady = true;
    await render(stepReady('github'));
    expect(query('home-onboarding-tool-linear')).not.toBeNull();
    // GitHub is offered when a push or pull request first needs it (CAN-4006).
    expect(query('home-onboarding-tool-github')).toBeNull();

    act(() => query('home-onboarding-category-designer')?.click());
    expect(onChangeRoles).toHaveBeenLastCalledWith(['designer']);

    // The runtime feeds the saved categories straight back: a design-only
    // pick drops the developer tools from the same row, with no Next.
    await render(stepReady('github'), ['designer']);
    expect(
      query('home-onboarding-category-designer')?.getAttribute('aria-pressed'),
    ).toBe('true');
    expect(query('home-onboarding-tool-linear')).toBeNull();

    act(() => query('home-onboarding-category-software-engineer')?.click());
    expect(onChangeRoles).toHaveBeenLastCalledWith([
      'designer',
      'software-engineer',
    ]);
    await render(stepReady('github'), ['designer', 'software-engineer']);
    expect(query('home-onboarding-tool-linear')).not.toBeNull();

    // Picking a selected category again turns it off.
    act(() => query('home-onboarding-category-designer')?.click());
    expect(onChangeRoles).toHaveBeenLastCalledWith(['software-engineer']);
  });

  it('follows AI providers with repo setup', async () => {
    await render(providersDone(), ['software-engineer']);
    expect(query('home-onboarding-suggestion-add-repo')).not.toBeNull();
    expect(
      query('home-onboarding-suggestion-cta-add-repo')?.textContent,
    ).toContain('Choose a local or remote repo to work in');
  });

  it('hides repo setup and developer tools for strictly nontechnical roles', async () => {
    state.pluginSuggestionsReady = true;
    await render(providersDone(), ['designer', 'marketing-sales']);
    expect(query('home-onboarding-suggestion-add-repo')).toBeNull();
    expect(query('home-onboarding-tool-github')).toBeNull();
    expect(query('home-onboarding-tool-linear')).toBeNull();
    // The tools step stays for its category row even with no tools left.
    expect(query('home-onboarding-suggestion-github')).not.toBeNull();
    expect(
      query('home-onboarding-category-designer')?.getAttribute('aria-pressed'),
    ).toBe('true');
  });

  it('skips a single entry via its forward arrow', async () => {
    await render(stepReady('github'));
    await act(async () => {
      query('home-onboarding-suggestion-dismiss-github')?.click();
      await Promise.resolve();
    });
    const next = lastUpdateApplied(stepReady('github'));
    expect(typeof next.entries.github?.dismissedAt).toBe('string');
    // Targeted disarm: only THIS entry's pending arm may be cancelled.
    expect(mockDisarmOnboardingSuggestion).toHaveBeenCalledWith('github');
  });

  it('uses the previous arrow to revisit the prior lesson and the forward arrow to return', async () => {
    await render(stepReady('github'));
    const previous = query(
      'home-onboarding-suggestion-dismiss-github-previous',
    );
    expect(previous?.getAttribute('title')).toBe('Previous');
    await act(async () => {
      previous?.click();
      await Promise.resolve();
    });
    expect(query('home-onboarding-suggestion-add-repo')).not.toBeNull();
    const updateCount = onUpdatePersisted.mock.calls.length;
    await act(async () => {
      query('home-onboarding-suggestion-dismiss-add-repo')?.click();
      await Promise.resolve();
    });
    expect(query('home-onboarding-suggestion-github')).not.toBeNull();
    expect(onUpdatePersisted).toHaveBeenCalledTimes(updateCount);
  });

  it('removes the duplicate add-repo prompt and keeps the repo-specific prompt in the GitHub example', async () => {
    state.projects = [
      { id: 'cw', type: 'cowork', name: 'Cowork' },
      { id: 'p1', type: 'project', name: 'canopy' },
    ];
    state.github = {
      authenticated: true,
      username: 'octocat',
      error: null,
      tokenSource: null,
      envOverride: false,
      envOverrideName: null,
      hasCredentialStoreLogin: false,
    };
    state.pluginSuggestionsReady = true;
    await render(providersDone(), ['software-engineer']);
    expect(query('home-onboarding-suggestion-add-repo')).toBeNull();
    expect(query('home-onboarding-tool-github')).toBeNull();

    await render(providersDone({ github: { completedAt: 'x' } }), [
      'software-engineer',
    ]);
    const prompt = query('home-onboarding-tool-example-github');
    expect(prompt?.textContent).toContain(addRepoTryPrompt('canopy'));
    await act(async () => {
      prompt?.click();
      await Promise.resolve();
    });
    expect(onInjectPrompt).toHaveBeenCalledWith(addRepoTryPrompt('canopy'));
    expect(mockArmOnboardingSuggestion).not.toHaveBeenCalled();
  });

  it('observes a GitHub connection made in Settings while the shared runtime stays mounted', async () => {
    state.github = {
      authenticated: false,
      username: null,
      error: null,
      tokenSource: null,
      envOverride: false,
      envOverrideName: null,
      hasCredentialStoreLogin: false,
    };
    state.pluginSuggestionsReady = true;
    await render(stepReady('plugin-examples-preview'));
    expect(query('home-onboarding-tool-example-github')).toBeNull();
    jest.mocked(window.api.loadGitHubPat).mockResolvedValue('test-pat');
    await act(async () => {
      window.dispatchEvent(new Event('canopy:github-connection-changed'));
      await Promise.resolve();
    });
    expect(query('home-onboarding-tool-example-github')).not.toBeNull();
  });

  it('completes Connect your tools when every recommended tool is connected', async () => {
    state.github = {
      authenticated: true,
      username: 'octocat',
      error: null,
      tokenSource: null,
      envOverride: false,
      envOverrideName: null,
      hasCredentialStoreLogin: false,
    };
    state.linearAvailable = true;
    state.pluginSuggestions = [
      {
        key: 'curated/notion',
        name: 'notion',
        displayName: 'Notion',
        description: 'Notes and docs',
        promptText: 'Summarize recent updates in Notion',
        promptTexts: ['Summarize recent updates in Notion'],
        enabled: true,
        enableKeys: ['curated/notion'],
        searchQuery: 'notion',
      },
    ];
    state.pluginSuggestionsReady = true;
    const previous = stepReady('github');

    await render(previous, ['software-engineer']);

    const next = lastUpdateApplied(previous);
    expect(typeof next.entries.github?.completedAt).toBe('string');
    expect(next.entries.github?.dismissedAt).toBeUndefined();
  });

  it('never auto-completes the global tools lesson from a template context (CAN-3032)', async () => {
    state.github = {
      authenticated: true,
      username: 'octocat',
      error: null,
      tokenSource: null,
      envOverride: false,
      envOverrideName: null,
      hasCredentialStoreLogin: false,
    };
    state.linearAvailable = true;
    state.pluginSuggestions = [
      {
        key: 'curated/notion',
        name: 'notion',
        displayName: 'Notion',
        description: 'Notes and docs',
        promptText: 'Summarize recent updates in Notion',
        promptTexts: ['Summarize recent updates in Notion'],
        enabled: true,
        enableKeys: ['curated/notion'],
        searchQuery: 'notion',
      },
    ];
    state.pluginSuggestionsReady = true;
    // The template bundles Notion, so the tools step no longer lists it; a
    // project-only enablement must not retire the global lesson.
    useOnboardingSuggestionSurfaces.setState({
      chatBlueprint: {
        projectId: 'marketing-1',
        externalId: '11111111-1111-4111-8111-111111111111',
        name: 'Marketing',
        pluginRefs: [BUILTIN_GIT_REF],
        starterPrompts: [],
        projectSelections: null,
      },
    });
    const previous = stepReady('github');
    await render(previous, ['software-engineer']);
    expect(query('home-onboarding-suggestion-github')).not.toBeNull();
    expect(
      onUpdatePersisted.mock.calls.some(
        ([updater]) =>
          typeof updater(previous).entries.github?.completedAt === 'string',
      ),
    ).toBe(false);
  });

  it('waits for the full recommendation catalog before auto-completing tools', async () => {
    state.github = {
      authenticated: true,
      username: 'octocat',
      error: null,
      tokenSource: null,
      envOverride: false,
      envOverrideName: null,
      hasCredentialStoreLogin: false,
    };
    state.linearAvailable = true;
    state.pluginSuggestionsReady = false;

    await render(stepReady('github'), ['software-engineer']);

    expect(onUpdatePersisted).not.toHaveBeenCalled();
  });

  it('shows three prompts for a connected tool and returns to all tools after selection', async () => {
    state.linearAvailable = true;
    state.projects = [{ id: 'p1', type: 'project', name: 'canopy' }];
    await render(stepReady('github'));
    await act(async () => {
      query('home-onboarding-tool-linear')?.click();
      await Promise.resolve();
    });
    const prompts = query('home-onboarding-tool-prompts')?.querySelectorAll(
      'button',
    );
    expect(prompts).toHaveLength(3);
    expect(prompts?.[0]?.textContent).toContain(LINEAR_TRY_PROMPT);
    expect(
      query('home-onboarding-tool-prompts-back')?.parentElement
        ?.nextElementSibling?.tagName,
    ).toBe('H2');
    expect(
      query('home-onboarding-tool-prompts-back')?.parentElement
        ?.nextElementSibling?.textContent,
    ).toBe('Try the Linear plugin');
    await act(async () => {
      prompts?.[0]?.click();
      await Promise.resolve();
    });
    expect(onInjectPrompt).toHaveBeenCalledWith(LINEAR_TRY_PROMPT);
    expect(mockArmOnboardingSuggestion).not.toHaveBeenCalled();
    expect(query('home-onboarding-tool-prompts')).toBeNull();
    expect(query('home-onboarding-tool-recommendations')).not.toBeNull();
  });

  it('opens all plugins from the end of the tool tiles without resolving the checklist', async () => {
    await render(stepReady('github'), ['software-engineer']);
    const seeAll = query('home-onboarding-tools-see-all');
    expect(seeAll).not.toBeNull();
    expect(
      query('home-onboarding-tool-recommendations')?.lastElementChild,
    ).toBe(seeAll);
    const updatesBeforeClick = onUpdatePersisted.mock.calls.length;
    await act(async () => {
      seeAll?.click();
      await Promise.resolve();
    });
    expect(mockOpenPluginsNavigation).toHaveBeenCalledWith({
      kind: 'discovery',
    });
    expect(onUpdatePersisted).toHaveBeenCalledTimes(updatesBeforeClick);
    expect(mockArmOnboardingSuggestion).not.toHaveBeenCalled();
  });

  it('highlights Plan mode without completing the lesson until a Plan query is sent', async () => {
    state.creditsEligible = true;
    state.projects = [{ id: 'p1', type: 'project', name: 'canopy' }];
    await render(stepReady('plan-mode'));
    expect(query('home-onboarding-suggestion-plan-mode')?.dataset.step).toBe(
      'create-plan',
    );

    await act(async () => {
      query('home-onboarding-suggestion-cta-create-plan')?.click();
      await Promise.resolve();
    });
    expect(mockSetMode).toHaveBeenCalledWith('chat');
    expect(useOnboardingSuggestionSurfaces.getState().planModeHighlight).toBe(
      true,
    );
    expect(mockStageTaskPlanPreset).not.toHaveBeenCalled();
    expect(mockNavigate).toHaveBeenCalledWith('home');
    expect(mockArmOnboardingSuggestion).not.toHaveBeenCalled();
  });

  it('does not repeat repo setup through the plan lesson after repo setup was resolved', async () => {
    state.creditsEligible = true;
    const previous = stepReady('plan-mode');
    await render(previous);
    expect(query('home-onboarding-suggestion-plan-mode')).toBeNull();
    expect(query('home-onboarding-suggestion-focus-shortcut')).not.toBeNull();
  });

  it('opens a connected Linear tool and injects its assigned-ticket prompt', async () => {
    state.linearAvailable = true;
    // The planning prompt still needs a code workspace.
    state.projects = [{ id: 'p1', type: 'project', name: 'canopy' }];
    await render(stepReady('github'), ['software-engineer']);
    act(() => query('home-onboarding-tool-linear')?.click());
    const prompt = query('home-onboarding-tool-prompts')?.querySelector(
      'button',
    ) as HTMLButtonElement | null;
    act(() => prompt?.click());
    expect(onInjectPrompt).toHaveBeenCalledWith(LINEAR_TRY_PROMPT);
    expect(mockRequestBranchPickerTab).not.toHaveBeenCalled();
  });

  it('retargets a Cowork-selected composer to a code project before a Linear prompt', async () => {
    state.linearAvailable = true;
    state.projects = [
      { id: 'cw', type: 'cowork', name: 'Cowork' },
      { id: 'p1', type: 'project', name: 'canopy' },
    ];
    mockComposerWorkspaceId = 'cw';
    await render(stepReady('github'), ['software-engineer']);
    await act(async () => {
      query('home-onboarding-tool-linear')?.click();
      await Promise.resolve();
    });
    await act(async () => {
      (
        query('home-onboarding-tool-prompts')?.querySelector(
          'button',
        ) as HTMLButtonElement | null
      )?.click();
      await Promise.resolve();
    });
    expect(mockSelectWorkspace).toHaveBeenCalledWith('p1');
    expect(onInjectPrompt).toHaveBeenCalledWith(LINEAR_TRY_PROMPT);
  });

  it('opens Settings for Linear/Ollama and the login modal for GitHub/Claude/Codex', async () => {
    await render(stepReady('github'), ['software-engineer']);
    await act(async () => {
      query('home-onboarding-tool-linear')?.click();
      await Promise.resolve();
    });
    // Deep-links to the Linear token input rather than the section top.
    expect(mockOpenSettings).toHaveBeenCalledWith('account', {
      scrollTo: 'settings-linear-token-input',
    });

    act(() => {
      useOnboardingChecklistStore.setState({
        state: {
          items: [{ id: 'start-chat', complete: true }],
          dismissedAt: null,
          snoozedUntil: null,
          providersNotUsed: [],
        },
      });
    });
    state.claude = {
      authenticated: false,
      accountLabel: null,
      detail: null,
      error: null,
    };
    state.codex = {
      authenticated: false,
      accountLabel: null,
      detail: null,
      error: null,
    };
    await render(stepReady('agent-connections'));
    await act(async () => {
      query('home-onboarding-suggestion-connect-claude')?.click();
      await Promise.resolve();
    });
    expect(query('auth-login-modal-stub')).not.toBeNull();
    const modalProps = mockAuthLoginModal.mock.calls.at(-1)?.[0];
    expect(modalProps?.provider).toBe('claude');
    expect(typeof modalProps?.onAuthorizationUrl).toBe('function');

    act(() => query('home-onboarding-suggestion-connect-ollama')?.click());
    expect(mockOpenSettings).toHaveBeenCalledWith('ollama');
  });

  it('opens the Add project dialog from the add-repo CTA', async () => {
    await render(providersDone());
    await act(async () => {
      query('home-onboarding-suggestion-cta-add-repo')?.click();
      await Promise.resolve();
    });
    expect(mockOpenAddWorkspaceModal).toHaveBeenCalledTimes(1);
  });

  describe('plugin suggestion rows', () => {
    const notion: OnboardingPluginSuggestionInput = {
      key: 'curated/notion',
      name: 'notion',
      displayName: 'Notion',
      description: 'Notes and docs',
      promptText: 'Summarize recent updates in Notion',
      promptTexts: [
        'Summarize recent updates in Notion',
        'Find decisions in Notion',
        'Draft a project brief from Notion',
      ],
      enabled: false,
      enableKeys: ['curated/notion'],
      searchQuery: 'notion',
    };

    it('installs an unconnected bundled plugin without a detail-page detour', async () => {
      state.pluginSuggestions = [notion];
      state.pluginSuggestionsReady = true;
      await render(stepReady('github'), ['software-engineer']);
      expect(
        query('home-onboarding-tool-plugin:curated/notion'),
      ).not.toBeNull();

      await act(async () => {
        query('home-onboarding-tool-plugin:curated/notion')?.click();
        await Promise.resolve();
      });
      expect(installOnboardingPlugin).toHaveBeenCalledWith(notion.enableKeys);
      expect(mockEnablePlugins).toHaveBeenCalledWith(notion.enableKeys);
      expect(mockOpenPluginsNavigation).not.toHaveBeenCalled();
    });

    it('shows an actionable error when enabling is unsafe', async () => {
      mockEnablePlugins.mockReturnValue(false);
      state.pluginSuggestions = [{ ...notion, enableKeys: [] }];
      state.pluginSuggestionsReady = true;
      await render(stepReady('github'), ['software-engineer']);
      await act(async () => {
        query('home-onboarding-tool-plugin:curated/notion')?.click();
        await Promise.resolve();
      });
      expect(container.textContent).toContain('Could not enable this plugin');
      expect(mockOpenPluginsNavigation).not.toHaveBeenCalled();
    });

    it('shows three prompts for an enabled plugin and returns to the grid', async () => {
      state.pluginSuggestions = [{ ...notion, enabled: true }];
      state.pluginSuggestionsReady = true;
      await render(stepReady('github'), ['software-engineer']);
      await act(async () => {
        query('home-onboarding-tool-plugin:curated/notion')?.click();
        await Promise.resolve();
      });
      const prompts = query('home-onboarding-tool-prompts')?.querySelectorAll(
        'button',
      );
      expect(prompts).toHaveLength(3);
      expect(query('home-onboarding-tool-prompts')?.textContent).not.toContain(
        'Connected',
      );
      await act(async () => {
        prompts?.[0]?.click();
        await Promise.resolve();
      });
      expect(onInjectPrompt).toHaveBeenCalledWith(notion.promptText);
      expect(mockArmOnboardingSuggestion).not.toHaveBeenCalled();
      expect(query('home-onboarding-tool-prompts')).toBeNull();
      expect(query('home-onboarding-tool-recommendations')).not.toBeNull();
    });
  });

  describe('empty-queue retirement', () => {
    const allResolved = (): HomeOnboardingSuggestionsPreferences =>
      providersDone({
        notifications: { dismissedAt: 'x' },
        'focus-shortcut': { dismissedAt: 'x' },
        'add-repo': { completedAt: 'x' },
        github: { dismissedAt: 'x' },
        'plugin-examples-preview': { dismissedAt: 'x' },
        'agent-connections': { completedAt: 'x' },
        'plan-mode': { completedAt: 'x' },
        linear: { dismissedAt: 'x' },
      });

    it('unlocks advanced prompts when every activity is completed or dismissed', async () => {
      state.pluginSuggestionsReady = true;
      state.github = { ...notConnectedGh(), authenticated: true };
      await render(allResolved(), ['software-engineer']);

      expect(query('home-onboarding-suggestions')).not.toBeNull();
      expect(query('home-onboarding-advanced-prompts')).not.toBeNull();
      expect(query('home-onboarding-suggestion-github')).toBeNull();
      expect(query('home-onboarding-checklist-progress')).toBeNull();
    });

    it('offers advanced prompts when all activities are dismissed', async () => {
      state.pluginSuggestionsReady = true;
      state.github = { ...notConnectedGh(), authenticated: true };
      const dismissed = persistedState(
        Object.fromEntries(
          [
            'focus-shortcut',
            'add-repo',
            'github',
            'plugin-examples-preview',
            'agent-connections',
            'plan-mode',
            'linear',
          ].map((id) => [id, { dismissedAt: 'x' }]),
        ),
      );
      await render(dismissed, ['software-engineer']);
      expect(query('home-onboarding-advanced-prompts')).not.toBeNull();
      expect(query('home-onboarding-suggestion-notifications')).toBeNull();
    });

    it('does not retire while the plugin-suggestion source is still loading', async () => {
      state.pluginSuggestionsReady = false;
      await render(allResolved(), ['software-engineer']);

      expect(query('home-onboarding-advanced-prompts')).toBeNull();
      expect(
        query('home-onboarding-checking-recommendations')?.textContent,
      ).toBe('Checking recommendations…');
      expect(useOnboardingSuggestionSurfaces.getState().queueStatus).toBe(
        'loading',
      );
    });

    it('moves past a repo-dependent plan lesson without repeating repo setup', async () => {
      // A Work-only user who already resolved repo setup should continue to
      // the next lesson instead of seeing a second repo prerequisite.
      state.projects = [{ id: 'cw', type: 'cowork', name: 'Cowork' }];
      state.claude = connectedAuth();
      state.pluginSuggestionsReady = true;
      await render(
        providersDone({
          notifications: { dismissedAt: 'x' },
          'add-repo': { completedAt: 'x' },
          github: { dismissedAt: 'x' },
          'agent-connections': { completedAt: 'x' },
          linear: { dismissedAt: 'x' },
        }),
        ['software-engineer'],
      );
      expect(query('home-onboarding-suggestion-agents')).toBeNull();
      expect(query('home-onboarding-suggestion-focus-shortcut')).not.toBeNull();

      // The next real lesson keeps the card active; no duplicate prerequisite
      // is needed to prevent an early empty-state handoff.
      expect(useOnboardingSuggestionSurfaces.getState().homeHasRows).toBe(true);
    });

    it('keeps the sidebar hidden when new advanced examples become available', async () => {
      state.github = notConnectedGh();
      // Real mount sequence: the catalog is never ready on the first render.
      state.pluginSuggestionsReady = false;
      const resolved = allResolved();
      resolved.entries['advanced:planning'] = { dismissedAt: 'x' };
      await render(resolved, ['designer']);
      expect(query('home-onboarding-checking-recommendations')).not.toBeNull();
      expect(trackOnboardingSuggestionsImpression).not.toHaveBeenCalled();
      state.pluginSuggestionsReady = true;
      await render(resolved, ['designer']);
      // With no connected plugins, the ongoing prompt sequence falls back to
      // generic developer examples while remaining sidebar-free.
      expect(query('home-onboarding-advanced-prompts')).not.toBeNull();
      expect(
        query('home-onboarding-advanced-prompt-generic-dev:0'),
      ).not.toBeNull();
      expect(useOnboardingSuggestionSurfaces.getState().sidebarHasRows).toBe(
        false,
      );
      expect(useOnboardingSuggestionSurfaces.getState().queueStatus).toBe(
        'has-rows',
      );
      expect(useOnboardingSuggestionSurfaces.getState().homeHasRows).toBe(true);
      expect(trackOnboardingSuggestionsImpression).toHaveBeenCalledTimes(1);

      state.projects = [{ id: 'p1', type: 'project', name: 'New project' }];
      state.github = { ...notConnectedGh(), authenticated: true };
      await render(resolved, ['software-engineer']);
      expect(query('home-onboarding-advanced-prompt-github:0')).not.toBeNull();
      expect(useOnboardingSuggestionSurfaces.getState().sidebarHasRows).toBe(
        false,
      );
      expect(useOnboardingSuggestionSurfaces.getState().queueStatus).toBe(
        'has-rows',
      );
      expect(useOnboardingSuggestionSurfaces.getState().homeHasRows).toBe(true);
      expect(trackOnboardingSuggestionsImpression).toHaveBeenCalledTimes(1);
      act(() => root.render(null));
      expect(useOnboardingSuggestionSurfaces.getState().sidebarHasRows).toBe(
        false,
      );
      expect(useOnboardingSuggestionSurfaces.getState().queueStatus).toBe(
        'loading',
      );
    });

    it('does not judge the queue empty while the GitHub connection probe is in flight', async () => {
      // The GitHub and Linear advanced examples exist only once connected;
      // while a probe is still "checking" the row is hidden, not deferred,
      // so the hand-back must wait for the answer. (An engineering role keeps
      // GitHub in the advanced examples; nontechnical roles filter it out.)
      state.pluginSuggestionsReady = true;
      state.github = null;
      const resolved = allResolved();
      resolved.entries['advanced:planning'] = { dismissedAt: 'x' };
      await render(resolved, ['software-engineer']);
      // Still probing: Home keeps the card rather than handing back.
      expect(useOnboardingSuggestionSurfaces.getState().homeHasRows).toBe(true);

      state.github = { ...notConnectedGh(), authenticated: true };
      await render(resolved, ['software-engineer']);
      expect(query('home-onboarding-advanced-prompt-github:1')).not.toBeNull();

      state.github = notConnectedGh();
      await render(resolved, ['software-engineer']);
      expect(query('home-onboarding-advanced-prompts')).not.toBeNull();
      expect(useOnboardingSuggestionSurfaces.getState().homeHasRows).toBe(true);
    });

    it('does not judge the queue empty while the provider-presence probe is in flight', async () => {
      state.github = notConnectedGh();
      // `import-projects` is filtered out until presence answers, so a
      // pending probe can be the only thing standing between "nothing left"
      // and one more row; the hand-back must wait for it.
      state.pluginSuggestionsReady = true;
      let resolvePresence: (value: {
        providerStoresPresent: boolean;
      }) => void = () => undefined;
      const presence = new Promise<{ providerStoresPresent: boolean }>(
        (resolve) => {
          resolvePresence = resolve;
        },
      );
      Object.defineProperty(window, 'api', {
        configurable: true,
        value: {
          ...window.api,
          externalProjects: {
            readProviderPresence: (): Promise<{
              providerStoresPresent: boolean;
            }> => presence,
          },
        },
      });
      const resolved = allResolved();
      resolved.entries['advanced:planning'] = { dismissedAt: 'x' };
      await render(resolved, ['designer']);
      // Still probing: Home keeps the card rather than handing back.
      expect(useOnboardingSuggestionSurfaces.getState().homeHasRows).toBe(true);

      await act(async () => {
        resolvePresence({ providerStoresPresent: false });
        await Promise.resolve();
      });
      await render(resolved, ['designer']);
      expect(query('home-onboarding-advanced-prompts')).not.toBeNull();
      expect(useOnboardingSuggestionSurfaces.getState().homeHasRows).toBe(true);
    });

    it('reports rows visible while anything renders', async () => {
      await render();
      expect(useOnboardingSuggestionSurfaces.getState().homeHasRows).toBe(true);
    });
  });

  describe('repo-referencing prompt CTAs retarget a Cowork composer', () => {
    it('retargets the GitHub TODO prompt to the NEWEST code project before injecting', async () => {
      state.projects = [
        { id: 'cw', type: 'cowork', name: 'Cowork' },
        { id: 'p1', type: 'project', name: 'older' },
        { id: 'p2', type: 'project', name: 'canopy' },
      ];
      mockComposerWorkspaceId = 'cw';
      state.github = { ...notConnectedGh(), authenticated: true };
      state.pluginSuggestionsReady = true;
      await render(providersDone({ github: { completedAt: 'x' } }), [
        'software-engineer',
      ]);
      await act(async () => {
        query('home-onboarding-tool-example-github')?.click();
        await Promise.resolve();
      });
      // Newest code workspace (sidebar appends last) — the same workspace
      // the prompt wording names.
      expect(mockSelectWorkspace).toHaveBeenCalledWith('p2');
      expect(onInjectPrompt).toHaveBeenCalledWith(addRepoTryPrompt('canopy'));
    });

    it('does not retarget account-wide tool prompts', async () => {
      state.projects = [
        { id: 'cw', type: 'cowork', name: 'Cowork' },
        { id: 'p1', type: 'project', name: 'canopy' },
      ];
      mockComposerWorkspaceId = 'cw';
      state.linearAvailable = true;
      await render(stepReady('github'), ['software-engineer']);
      expect(query('home-onboarding-suggestion-github')?.dataset.step).toBe(
        'connect-tools',
      );
      act(() => query('home-onboarding-tool-linear')?.click());
      await act(async () => {
        query('home-onboarding-tool-prompts')
          ?.querySelectorAll('button')[1]
          ?.click();
        await Promise.resolve();
      });
      expect(mockSelectWorkspace).not.toHaveBeenCalled();
      expect(onInjectPrompt).toHaveBeenCalledWith(
        'Summarize what my team shipped this cycle in Linear',
      );
    });
  });

  it('omits the whole-module dismissal and promotional subtitle', async () => {
    await render();
    expect(query('home-onboarding-suggestions-dismiss')).toBeNull();
    expect(container.textContent).not.toContain(
      'Try something new. More suggestions appear as you go.',
    );
  });
});

describe('launch-at-login entry (CAN-3449)', () => {
  const offStatus = {
    platform: 'darwin' as const,
    supported: true,
    enabled: false,
    pendingApproval: false,
  };

  it('offers Turn on and completes once the OS will open the app', async () => {
    jest
      .mocked(window.api.launchAtLogin.getStatus)
      .mockResolvedValue(offStatus);
    jest.mocked(window.api.launchAtLogin.setEnabled).mockResolvedValue({
      ok: true,
      status: { ...offStatus, enabled: true },
    });
    await render(stepReady('launch-at-login'));

    const row = query('home-onboarding-suggestion-launch-at-login');
    expect(row?.getAttribute('data-step')).toBe('enable-launch-at-login');
    expect(row?.querySelector('h2')?.textContent).toContain(
      `Open ${brandText.appName} when you sign in`,
    );
    const cta = query('home-onboarding-suggestion-cta-enable-launch-at-login');
    expect(cta?.textContent).toBe(
      'Pick up where you left off after a restart.',
    );

    await act(async () => {
      cta?.click();
      await Promise.resolve();
    });

    expect(window.api.launchAtLogin.setEnabled).toHaveBeenCalledWith(true);
    expect(query('home-onboarding-suggestion-launch-at-login')).toBeNull();
  });

  it('keeps asking when the OS refuses or the request fails', async () => {
    jest
      .mocked(window.api.launchAtLogin.getStatus)
      .mockResolvedValue(offStatus);
    jest
      .mocked(window.api.launchAtLogin.setEnabled)
      .mockRejectedValueOnce(new Error('ipc down'))
      .mockResolvedValueOnce({
        ok: false,
        reason: 'refused',
        status: offStatus,
      });
    await render(stepReady('launch-at-login'));

    for (let attempt = 0; attempt < 2; attempt += 1) {
      await act(async () => {
        query('home-onboarding-suggestion-cta-enable-launch-at-login')?.click();
        await Promise.resolve();
        await Promise.resolve();
      });
      expect(
        query('home-onboarding-suggestion-launch-at-login')?.getAttribute(
          'data-step',
        ),
      ).toBe('enable-launch-at-login');
    }
    expect(window.api.launchAtLogin.setEnabled).toHaveBeenCalledTimes(2);
  });

  it('sends a registration waiting for approval to System Settings', async () => {
    jest
      .mocked(window.api.launchAtLogin.getStatus)
      .mockResolvedValue({ ...offStatus, pendingApproval: true });
    await render(stepReady('launch-at-login'));

    const row = query('home-onboarding-suggestion-launch-at-login');
    expect(row?.getAttribute('data-step')).toBe(
      'launch-at-login-needs-approval',
    );
    const cta = query(
      'home-onboarding-suggestion-cta-launch-at-login-needs-approval',
    );
    expect(cta?.textContent).toBe(
      `Allow ${brandText.appName} in System Settings to finish turning this on.`,
    );
    await act(async () => {
      cta?.click();
      await Promise.resolve();
    });
    expect(window.api.launchAtLogin.openSystemSettings).toHaveBeenCalledTimes(
      1,
    );
    expect(window.api.launchAtLogin.setEnabled).not.toHaveBeenCalled();
  });

  it('is left out of a build that cannot manage it', async () => {
    await render(stepReady('launch-at-login'));
    expect(query('home-onboarding-suggestion-launch-at-login')).toBeNull();
  });

  it('shows no rows until the OS has answered', async () => {
    jest
      .mocked(window.api.launchAtLogin.getStatus)
      .mockReturnValue(new Promise(() => undefined));
    await render(stepReady('launch-at-login'));
    expect(query('home-onboarding-suggestion-launch-at-login')).toBeNull();
    expect(useOnboardingSuggestionSurfaces.getState().queueStatus).toBe(
      'loading',
    );
  });
});

describe('focus-shortcut entry (CAN-1963)', () => {
  it('offers Turn on with the chord and completes once the OS accepts it', async () => {
    jest.mocked(window.api.globalFocusShortcut.update).mockResolvedValue({
      ok: true,
      status: {
        enabled: true,
        accelerator: 'CommandOrControl+Shift+O',
        registered: true,
        platform: 'darwin',
      },
    });
    await render(stepReady('focus-shortcut'));

    const row = query('home-onboarding-suggestion-focus-shortcut');
    expect(row?.getAttribute('data-step')).toBe('enable-focus-shortcut');
    // The row must say what turning it on does, not read like an instruction
    // for something that already works.
    expect(row?.querySelector('h2')?.textContent).toContain(
      `Global hotkey for the ${brandText.appName} app`,
    );
    expect(
      query('home-onboarding-suggestion-cta-enable-focus-shortcut')
        ?.textContent,
    ).toBe(`Bring ${brandText.appName} to the front while using any other app`);

    const cta = query('home-onboarding-suggestion-cta-enable-focus-shortcut');
    await act(async () => {
      cta?.click();
      await Promise.resolve();
    });

    expect(window.api.globalFocusShortcut.update).toHaveBeenCalledWith({
      enabled: true,
    });
    // Completion is derived from the live status. Completed rows leave the
    // queue immediately under the current checklist behavior.
    expect(query('home-onboarding-suggestion-focus-shortcut')).toBeNull();
  });

  it('sends a blocked chord to the Settings recorder', async () => {
    jest.mocked(window.api.globalFocusShortcut.getStatus).mockResolvedValue({
      enabled: true,
      accelerator: 'CommandOrControl+Shift+O',
      registered: false,
      failure: 'in-use',
      platform: 'darwin',
    });
    await render(stepReady('focus-shortcut'));

    const row = query('home-onboarding-suggestion-focus-shortcut');
    expect(row?.getAttribute('data-step')).toBe('focus-shortcut-blocked');
    expect(row?.textContent).toContain(
      'Another app is using ⌘⇧O. Choose a different one',
    );

    const cta = query('home-onboarding-suggestion-cta-focus-shortcut-blocked');
    await act(async () => {
      cta?.click();
      await Promise.resolve();
    });

    expect(mockOpenSettings).toHaveBeenCalledWith('shortcuts', {
      scrollTo: 'settings-global-focus-shortcut',
    });
    expect(window.api.globalFocusShortcut.update).not.toHaveBeenCalled();
  });
});

describe('daily free AI Credits card', () => {
  function undecided(): void {
    jest.mocked(window.api.loadCloudDailyCreditDrip).mockResolvedValue({
      available: true,
      resolved: true,
      preference: { enabled: false, decidedAt: null, capCredits: 10 },
    });
  }

  function savedAs(enabled: boolean): void {
    jest.mocked(window.api.saveCloudDailyCreditDrip).mockResolvedValue({
      enabled,
      decidedAt: '2026-10-06T19:00:00.000Z',
      capCredits: 10,
      balanceCredits: enabled ? 10 : 0,
      granted: enabled ? 10 : 0,
    });
  }

  async function flush(): Promise<void> {
    await act(async () => {
      await Promise.resolve();
      await Promise.resolve();
    });
  }

  it('follows AI provider setup for an undecided user with Turn on and Not now', async () => {
    undecided();
    await render(persistedState({ 'agent-connections': { completedAt: 'x' } }));
    await flush();

    const rows = document.body.querySelectorAll(
      '[data-testid^="home-onboarding-suggestion-"][data-step]',
    );
    expect(rows[0]?.getAttribute('data-testid')).toBe(
      'home-onboarding-suggestion-daily-credits',
    );
    expect(rows[0]?.textContent).toContain('Free AI Credits, every single day');
    expect(rows[0]?.textContent).toContain(
      'Claim 10 free AI Credits daily. Use them with any model, on top of your own plan.',
    );
    expect(query('home-onboarding-daily-credits-turn-on')?.textContent).toBe(
      'Claim',
    );
    expect(query('home-onboarding-daily-credits-not-now')).not.toBeNull();
  });

  it('stays out of the queue while no cloud credential is connected', async () => {
    await render();
    await flush();
    expect(query('home-onboarding-suggestion-daily-credits')).toBeNull();
  });

  it('saves enabled: true on Turn on, refreshes credits, and completes the card', async () => {
    undecided();
    savedAs(true);
    await render(persistedState({ 'agent-connections': { completedAt: 'x' } }));
    await flush();

    act(() => query('home-onboarding-daily-credits-turn-on')?.click());
    await flush();

    expect(window.api.saveCloudDailyCreditDrip).toHaveBeenCalledWith({
      enabled: true,
    });
    expect(mockRefreshAiCreditsAfterDripChange).toHaveBeenCalledTimes(1);
    expect(query('home-onboarding-suggestion-daily-credits')).toBeNull();
  });

  it('saves enabled: false on Not now and completes the card', async () => {
    undecided();
    savedAs(false);
    await render(persistedState({ 'agent-connections': { completedAt: 'x' } }));
    await flush();

    act(() => query('home-onboarding-daily-credits-not-now')?.click());
    await flush();

    expect(window.api.saveCloudDailyCreditDrip).toHaveBeenCalledWith({
      enabled: false,
    });
    expect(query('home-onboarding-suggestion-daily-credits')).toBeNull();
  });

  it('keeps the card with an inline notice when the save fails', async () => {
    undecided();
    jest
      .mocked(window.api.saveCloudDailyCreditDrip)
      .mockRejectedValue(new Error('offline'));
    await render(persistedState({ 'agent-connections': { completedAt: 'x' } }));
    await flush();

    act(() => query('home-onboarding-daily-credits-turn-on')?.click());
    await flush();

    expect(query('home-onboarding-suggestion-daily-credits')).not.toBeNull();
    expect(query('home-onboarding-daily-credits-error')?.textContent).toContain(
      "Couldn't save. Try again.",
    );
    expect(
      query('home-onboarding-daily-credits-turn-on')?.hasAttribute('disabled'),
    ).toBe(false);
    expect(mockRefreshAiCreditsAfterDripChange).not.toHaveBeenCalled();
  });
});

describe('below the startup resume row (CAN-4746)', () => {
  const ADVANCED_IDS = [
    'focus-shortcut',
    'add-repo',
    'github',
    'plugin-examples-preview',
    'agent-connections',
    'plan-mode',
    'linear',
  ];
  let homeHost: HTMLDivElement;
  let chatHost: HTMLDivElement;

  beforeEach(() => {
    homeHost = document.createElement('div');
    chatHost = document.createElement('div');
    document.body.append(homeHost, chatHost);
    state.projects = [{ id: 'p1', type: 'project', name: 'Project' }];
    state.github = { ...notConnectedGh(), authenticated: true };
    state.pluginSuggestions = [
      {
        key: 'curated/notion',
        name: 'notion',
        displayName: 'Notion',
        description: 'Notes and docs',
        promptText: 'Summarize recent updates in Notion',
        promptTexts: [
          'Summarize recent updates in Notion',
          'Find decisions in Notion',
          'Draft a project brief from Notion',
        ],
        enabled: true,
        enableKeys: ['curated/notion'],
        searchQuery: 'notion',
      },
    ];
    state.pluginSuggestionsReady = true;
  });

  afterEach(() => {
    act(() => root.render(null));
    homeHost.remove();
    chatHost.remove();
  });

  function advancedDone(
    entries: HomeOnboardingSuggestionsPreferences['entries'] = {},
  ): HomeOnboardingSuggestionsPreferences {
    return persistedState({
      ...Object.fromEntries(
        ADVANCED_IDS.map((id) => [id, { completedAt: 'x' }]),
      ),
      ...entries,
    });
  }

  async function renderHosts(
    persisted: HomeOnboardingSuggestionsPreferences,
  ): Promise<void> {
    await act(async () => {
      root.render(
        createElement(HomeOnboardingSuggestions, {
          persisted,
          onUpdatePersisted,
          onInjectPrompt,
          selectedRoles: ['software-engineer'],
          onChangeRoles,
          homeHost,
          chatHost,
        }),
      );
      await Promise.resolve();
    });
  }

  function rowIds(host: HTMLElement): string[] {
    return Array.from(
      host.querySelectorAll<HTMLElement>(
        '[data-testid^="home-onboarding-advanced-prompt-"]',
      ),
    )
      .map((row) => row.dataset.testid ?? '')
      .filter((id) => !id.includes('-dismiss-'));
  }

  function setResumePending(homeResumePending: boolean): void {
    act(() => {
      useOnboardingSuggestionSurfaces.setState({ homeResumePending });
    });
  }

  it('shows Home only the lead suggestion and restores the window when Continue clears', async () => {
    await renderHosts(advancedDone());
    const fullWindow = rowIds(homeHost);
    expect(fullWindow.length).toBeGreaterThan(1);
    expect(rowIds(chatHost)).toEqual(fullWindow);

    setResumePending(true);
    expect(rowIds(homeHost)).toEqual(fullWindow.slice(0, 1));
    expect(
      homeHost.querySelector(
        '[data-testid="home-onboarding-advanced-prompts"]',
      ),
    ).not.toBeNull();
    // The chat surface and the shared queue keep the full window.
    expect(rowIds(chatHost)).toEqual(fullWindow);
    expect(useOnboardingSuggestionSurfaces.getState()).toMatchObject({
      homeHasRows: true,
      queueStatus: 'has-rows',
    });
    expect(onUpdatePersisted).not.toHaveBeenCalled();

    setResumePending(false);
    expect(rowIds(homeHost)).toEqual(fullWindow);
    expect(rowIds(chatHost)).toEqual(fullWindow);
    expect(onUpdatePersisted).not.toHaveBeenCalled();
  });

  it('exposes the next eligible suggestion when the visible one completes', async () => {
    await renderHosts(advancedDone());
    const fullWindow = rowIds(homeHost);
    setResumePending(true);
    act(() =>
      homeHost
        .querySelector<HTMLElement>(`[data-testid="${fullWindow[0]}"]`)
        ?.click(),
    );
    // Only the visible lead row is armed (advanced:github:0 here).
    expect(mockArmOnboardingSuggestion).toHaveBeenCalledTimes(1);
    expect(mockArmOnboardingSuggestion).toHaveBeenCalledWith(
      'advanced:github:0',
    );

    // Completing the armed lead row (a send) reveals the next row, not a
    // hidden one further down, and leaves the hidden rows untouched.
    await renderHosts(
      advancedDone({ 'advanced:github:0': { completedAt: 'y' } }),
    );
    expect(rowIds(homeHost)).toEqual([fullWindow[1]]);
    expect(rowIds(chatHost)[0]).toBe(fullWindow[1]);
    expect(onUpdatePersisted).not.toHaveBeenCalled();
  });

  it('keeps a single setup step’s heading, counter and arrows', async () => {
    setResumePending(true);
    await renderHosts(stepReady('github'));
    expect(
      homeHost.querySelector(
        '[data-testid="home-onboarding-suggestion-github"]',
      ),
    ).not.toBeNull();
    expect(homeHost.querySelectorAll('h2')).toHaveLength(1);
    expect(
      homeHost.querySelector(
        '[data-testid="home-onboarding-checklist-progress"]',
      ),
    ).not.toBeNull();
    await act(async () => {
      homeHost
        .querySelector<HTMLElement>(
          '[data-testid="home-onboarding-suggestion-dismiss-github"]',
        )
        ?.click();
      await Promise.resolve();
    });
    const next = lastUpdateApplied(stepReady('github'));
    expect(typeof next.entries.github?.dismissedAt).toBe('string');
    expect(next.entries.linear?.dismissedAt).toBeUndefined();
  });

  it('skips only the visible template prompt on collapsed Home while chat keeps its full step', async () => {
    useOnboardingSuggestionSurfaces.setState({
      homeResumePending: true,
      chatBlueprint: {
        projectId: 'ops-1',
        externalId: '44444444-4444-4444-8444-444444444444',
        name: 'Operations',
        pluginRefs: [],
        projectSelections: null,
        starterPrompts: [
          { id: 'first', text: 'Draft the weekly digest.' },
          { id: 'second', text: 'Review the support backlog.' },
          { id: 'third', text: 'Find support trends.' },
        ],
      },
    });
    const persisted = advancedDone();
    await renderHosts(persisted);
    const prefix = 'home-onboarding-suggestion-';
    const first = 'blueprint:ops-1:prompt:first';
    const second = 'blueprint:ops-1:prompt:second';
    const third = 'blueprint:ops-1:prompt:third';
    expect(
      homeHost.querySelector(`[data-testid="${prefix}${first}"]`),
    ).not.toBeNull();
    expect(
      homeHost.querySelector(`[data-testid="${prefix}${second}"]`),
    ).toBeNull();
    expect(
      chatHost.querySelector(`[data-testid="${prefix}${third}"]`),
    ).not.toBeNull();
    const skip = homeHost.querySelector<HTMLElement>(
      `[data-testid="${prefix}dismiss-${first}"]`,
    );
    act(() => skip?.click());
    const next = lastUpdateApplied(persisted);
    expect(typeof next.entries[first]?.dismissedAt).toBe('string');
    expect(next.entries[second]).toBeUndefined();
    expect(next.entries[third]).toBeUndefined();
    expect(skip?.getAttribute('aria-label')).toBe(
      'Skip Draft the weekly digest.',
    );
    await renderHosts(next);
    expect(
      homeHost.querySelector(`[data-testid="${prefix}${second}"]`),
    ).not.toBeNull();
    expect(
      homeHost.querySelector(`[data-testid="${prefix}${third}"]`),
    ).toBeNull();
  });

  it('keeps an exhausted queue empty while resume is pending', async () => {
    state.pluginSuggestions = [];
    state.github = notConnectedGh();
    const persisted = advancedDone(
      Object.fromEntries(
        Array.from({ length: 5 }, (_, index) => [
          `advanced:generic-dev:${index}`,
          { completedAt: 'x' },
        ]),
      ),
    );
    setResumePending(true);
    await renderHosts(persisted);
    expect(
      homeHost.querySelector('[data-testid="home-onboarding-suggestions"]'),
    ).toBeNull();
    expect(
      chatHost.querySelector('[data-testid="home-onboarding-suggestions"]'),
    ).toBeNull();
    expect(useOnboardingSuggestionSurfaces.getState()).toMatchObject({
      homeHasRows: false,
      queueStatus: 'exhausted',
    });
  });
});
