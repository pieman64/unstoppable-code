/**
 * @jest-environment jsdom
 */
(
  globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;

import {
  CLIENT_FEATURE_FLAGS,
  getDefaultFeatureFlagSnapshot,
} from '@canopy/protocol/feature-flags';
import { act, type JSX } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { focusViaKeyboard } from '@/test-utils/dom';
import type { FeatureFlagSnapshot } from '@canopy/protocol/feature-flags';
import { PLAN_EXPLORE_CHAT_PROJECT_ID } from '@canopy/desktop-shared/types';
import type {
  CanopyCloudAccountPublicState,
  ChatWindowCommand,
  GitExecutableInstallProgress,
  GitExecutableStatus,
  PortalChatComposerCommandResult,
  PortalChatComposerRendererRequest,
} from '@canopy/desktop-shared/types';
import { CONSENT_TOS_VERSION } from '@canopy/desktop-shared/constants/consent';
import { POSTHOG_REPLAY_BLOCK_CLASS } from '@canopy/desktop-instrumentation/posthog-replay-privacy';
import { NAVIGATION_PAGE_REPLAY_PRIVACY } from '@canopy/desktop-instrumentation/posthog-replay-surfaces';
import type * as ReplaySurfaces from '@canopy/desktop-instrumentation/posthog-replay-surfaces';
import { CANOPY_CLOUD_ACCOUNT_CHANGED_EVENT } from '@canopy/desktop-shared/constants/canopy-cloud';
import type { CanopyGuestConsent } from '@canopy/desktop-shared/constants/consent';
import App from '../App';
import * as chatHydration from '../stores/chat/hydration';
import type * as ChatStoreModule from '../stores/chatStore';
import type * as NavigationHistoryStoreModule from '../stores/navigationHistoryStore';
import type * as SettingsDestinationsModule from '../lib/navigation/settings-destinations';
import {
  openCloudAccountSettings,
  openIntegrationSettings,
} from '../lib/navigation/settings-destinations';
import { useChatStore } from '../stores/chatStore';
import type { ChatTab } from '../stores/chat/types';
import { HEADER_STATES_PAGE_STORAGE_KEY } from '../components/sidebar/header-states-page-flag';
import { useFeatureFlagsStore } from '../stores/featureFlagsStore';
import { resetExperimentalFeaturesStoreForTest } from '../stores/experimentalFeaturesStore';
import { resetLabsExperimentsStoreForTest } from '../stores/labsExperimentsStore';
import {
  makeTestLabsSnapshot,
  pageExperimentsOn,
} from '@/test-utils/labsExperiments';
import { initNavigationHistoryTracking } from '../stores/navigationHistoryStore';
import { useNavigationStore } from '../stores/navigationStore';
import { useProjectsStore } from '../stores/projectsStore';
import { useSidebarStore } from '../stores/sidebarStore';
import { useSidebarPageHandoffStore } from '../stores/sidebarPageHandoffStore';

jest.mock(
  '../components/sidebar/AppSidebar',
  (): {
    AppSidebar: (props: {
      canopyPortalEnabled: boolean;
      settingsOpen: boolean;
    }) => JSX.Element;
  } => ({
    AppSidebar: ({
      canopyPortalEnabled,
      settingsOpen,
    }: {
      canopyPortalEnabled: boolean;
      settingsOpen: boolean;
    }): JSX.Element => (
      <aside
        data-testid="sidebar"
        data-portal-enabled={canopyPortalEnabled}
        data-sidebar-page-open={settingsOpen ? 'true' : 'false'}
      />
    ),
  }),
);
jest.mock(
  '../components/app-advisor/AppAdvisorRuntimeBridge',
  (): {
    AppAdvisorMainRuntimeBridge: () => JSX.Element;
  } => ({
    AppAdvisorMainRuntimeBridge: (): JSX.Element => (
      <div data-testid="app-advisor-runtime-bridge" />
    ),
  }),
);
jest.mock(
  '../components/pages/MainPage',
  (): {
    MainPage: () => JSX.Element;
  } => ({
    MainPage: (): JSX.Element => <main data-testid="main-page" />,
  }),
);
jest.mock(
  '../components/pages/OverviewPage',
  (): {
    OverviewPage: () => JSX.Element;
  } => ({
    OverviewPage: (): JSX.Element => <div data-testid="overview-page" />,
  }),
);
jest.mock(
  '../components/pages/HeaderStateGalleryPage',
  (): {
    HeaderStateGalleryPage: () => JSX.Element;
  } => ({
    HeaderStateGalleryPage: (): JSX.Element => (
      <div data-testid="header-state-gallery-page" />
    ),
  }),
);
jest.mock(
  '../components/pages/WorkersPage',
  (): {
    WorkersPage: () => JSX.Element;
  } => ({
    WorkersPage: (): JSX.Element => <div data-testid="workers-page" />,
  }),
);
jest.mock(
  '../components/pages/HomePage',
  (): {
    HomePage: () => JSX.Element;
  } => ({
    // The MRU startup-routing effect under test navigates to `home` by
    // default when there's no last-active-context, mounting the real
    // HomePage/HomeSurface. That surface renders a Slate editor, which is
    // unrelated to this suite's feature-flag gating and pulls in
    // `structuredClone`, which jsdom's global scope doesn't provide. Stub it
    // out like `MainPage` above.
    HomePage: (): JSX.Element => <div data-testid="home-page" />,
  }),
);
jest.mock(
  '../components/portal/CanopyPortalModal',
  (): {
    CanopyPortalModal: () => JSX.Element;
  } => ({
    CanopyPortalModal: (): JSX.Element => (
      <section data-testid="canopy-portal-modal" />
    ),
  }),
);
jest.mock(
  '../components/settings/SettingsOverlay',
  (): {
    SettingsOverlay: () => JSX.Element;
  } => ({
    SettingsOverlay: (): JSX.Element => (
      <section data-testid="settings-overlay" />
    ),
  }),
);
jest.mock(
  '../components/command-palette/CommandPalette',
  (): {
    CommandPalette: () => JSX.Element;
  } => ({
    CommandPalette: (): JSX.Element => (
      <section data-testid="command-palette" />
    ),
  }),
);
jest.mock(
  '../components/app-advisor/AppAdvisorQuickPromptModal',
  (): {
    AppAdvisorQuickPromptModal: () => JSX.Element;
  } => ({
    AppAdvisorQuickPromptModal: (): JSX.Element => <section />,
  }),
);
jest.mock(
  '../components/file-search-palette/FileSearchPalette',
  (): {
    FileSearchPalette: () => JSX.Element;
  } => ({
    FileSearchPalette: (): JSX.Element => <section />,
  }),
);
jest.mock(
  '../components/pr-picker/PrPicker',
  (): {
    PrPicker: () => JSX.Element;
  } => ({
    PrPicker: (): JSX.Element => <section />,
  }),
);
jest.mock(
  '../components/chat/FileTabCloseGuard',
  (): {
    FileTabCloseGuard: () => null;
  } => ({
    FileTabCloseGuard: (): null => null,
  }),
);
jest.mock(
  '../components/onboarding/AppLoadingScreen',
  (): {
    AppLoadingScreen: () => JSX.Element;
  } => ({
    AppLoadingScreen: (): JSX.Element => (
      <div data-testid="app-loading-screen" />
    ),
  }),
);
jest.mock(
  '../components/onboarding/CloudSignInGate',
  (): {
    CloudSignInGate: (props: { onConnected: () => void }) => JSX.Element;
  } => ({
    CloudSignInGate: ({
      onConnected,
    }: {
      onConnected: () => void;
    }): JSX.Element => (
      <div data-testid="cloud-sign-in-gate">
        <button type="button" onClick={onConnected}>
          Connect
        </button>
        <button
          data-testid="cloud-sign-in-gate-ready"
          type="button"
          onClick={onConnected}
        >
          Already connected
        </button>
      </div>
    ),
  }),
);
jest.mock(
  '../components/shared/StatusBlocks',
  (): {
    LoadingPlaceholder: (props: { className?: string }) => JSX.Element;
  } => ({
    LoadingPlaceholder: ({
      className,
    }: {
      className?: string;
    }): JSX.Element => <div className={className}>Loading</div>,
  }),
);
jest.mock(
  '../components/shared/ToastContainer',
  (): {
    ToastContainer: () => null;
  } => ({
    ToastContainer: (): null => null,
  }),
);
jest.mock(
  '../components/worktree/AddRepoModal',
  (): {
    AddWorkspaceModalHost: () => null;
  } => ({
    AddWorkspaceModalHost: (): null => null,
  }),
);
// Script review and add notices need `window.api.scriptActions`; their host
// has its own suites.
jest.mock('../components/script-actions/ScriptActionsDesktopHost', () => ({
  ScriptActionsDesktopHost: (): null => null,
}));
// Every install starts the onboarding suggestions module, whose provider
// probes need a fuller `window.api` than this suite stubs. The module is
// covered by its own suites; keep it out of the feature-flag surface.
jest.mock(
  '../components/home/onboarding-suggestions/OnboardingSuggestionsRuntime',
  () => ({
    OnboardingSuggestionsRuntime: (): null => null,
  }),
);

// No page is classified `blocked` today; a fixture classification keeps the
// blocked path on <main> covered.
jest.mock(
  '@canopy/desktop-instrumentation/posthog-replay-surfaces',
  (): typeof ReplaySurfaces => {
    const actual: typeof ReplaySurfaces = jest.requireActual(
      '@canopy/desktop-instrumentation/posthog-replay-surfaces',
    );
    return {
      ...actual,
      NAVIGATION_PAGE_REPLAY_PRIVACY: Object.freeze({
        ...actual.NAVIGATION_PAGE_REPLAY_PRIVACY,
        'header-states': 'blocked',
      }),
    };
  },
);
jest.mock('../components/remote-access/RemoteAccessHost', () => ({
  RemoteAccessHost: (): JSX.Element => <div data-testid="remote-access-host" />,
}));
jest.mock('../components/github/GitHubConnectOfferHost', () => ({
  GitHubConnectOfferHost: (): null => null,
}));
jest.mock('../hooks/usePipelineCompletionToasts', () => ({
  usePipelineCompletionToasts: jest.fn(),
}));
jest.mock('../hooks/useTerminalActivitySubscription', () => ({
  useTerminalActivitySubscription: jest.fn(),
}));
jest.mock('../hooks/useTerminalDrawerAttentionSubscriptions', () => ({
  useTerminalDrawerAttentionSubscriptions: jest.fn(),
}));
jest.mock('../hooks/useTerminalCompletionToasts', () => ({
  useTerminalCompletionToasts: jest.fn(),
}));
jest.mock('../stores/chat/chat-prefetch', () => ({
  useChatPrefetch: jest.fn(),
}));
jest.mock('../hooks/useChatEventSubscriptions', () => ({
  useChatEventSubscriptions: jest.fn(),
}));
jest.mock('../hooks/useStandaloneChatEventSubscriptions', () => ({
  useStandaloneChatEventSubscriptions: jest.fn(),
}));
jest.mock('../hooks/useGlobalShortcuts', () => ({
  useGlobalShortcuts: jest.fn(),
}));
jest.mock('../hooks/useUpdateBusyReporter', () => ({
  useUpdateBusyReporter: jest.fn(),
}));
jest.mock('../hooks/useCanopyPortalSubscription', () => ({
  useCanopyPortalSubscription: jest.fn(),
}));
jest.mock('../lib/theme', () => ({
  applyDisplayPreferences: jest.fn(),
  applyTheme: jest.fn(),
  applyUiScale: jest.fn(),
}));
jest.mock(
  '../lib/osNotifications',
  (): {
    getInAppNotificationPlacement: () => 'bottom-right';
    refreshInAppNotificationPrefs: jest.Mock;
    refreshOsNotificationPrefs: jest.Mock;
    setOsNotificationNavigationHandler: jest.Mock;
    subscribeToInAppNotificationPrefs: () => () => undefined;
  } => ({
    getInAppNotificationPlacement: (): 'bottom-right' => 'bottom-right',
    refreshInAppNotificationPrefs: jest.fn(),
    refreshOsNotificationPrefs: jest.fn(),
    setOsNotificationNavigationHandler: jest.fn(),
    subscribeToInAppNotificationPrefs: (): (() => undefined) => (): undefined =>
      undefined,
  }),
);
jest.mock('../stores/chatStore', (): typeof ChatStoreModule => {
  const actual = jest.requireActual<typeof ChatStoreModule>(
    '../stores/chatStore',
  );
  return {
    ...actual,
    initializeVisibleContextSync: jest.fn<() => void, []>(
      (): (() => void) => (): void => undefined,
    ),
  };
});
jest.mock(
  '../lib/current-ui-state/initCurrentUiStateTracking',
  (): {
    initCurrentUiStateTracking: jest.Mock;
  } => ({
    initCurrentUiStateTracking: jest.fn<() => void, []>(
      (): (() => void) => (): void => undefined,
    ),
  }),
);
jest.mock('../stores/navigationHistoryStore', () => {
  const actual = jest.requireActual<typeof NavigationHistoryStoreModule>(
    '../stores/navigationHistoryStore',
  );
  return {
    ...actual,
    initNavigationHistoryTracking: jest.fn(
      (): (() => void) => (): void => undefined,
    ),
  };
});

jest.mock('../lib/navigation/settings-destinations', () => {
  const actual = jest.requireActual<typeof SettingsDestinationsModule>(
    '../lib/navigation/settings-destinations',
  );
  return {
    ...actual,
    openCloudAccountSettings: jest.fn<void, []>(),
    openIntegrationSettings: jest.fn<void, []>(),
  };
});

const initNavigationHistoryTrackingMock = jest.mocked(
  initNavigationHistoryTracking,
);

type ActivationCampaignListener = Parameters<
  typeof window.api.onActivationCampaignNavigate
>[0];

let activationCampaignListener: ActivationCampaignListener | null = null;

type FeatureFlagListener = Parameters<
  typeof window.api.featureFlags.onSnapshotChanged
>[0];

let featureFlagListener: FeatureFlagListener | null = null;
let labsSnapshot = makeTestLabsSnapshot();
let chatWindowCommandListener: ((command: ChatWindowCommand) => void) | null =
  null;
let portalComposerCommandListener:
  | ((request: PortalChatComposerRendererRequest) => void)
  | null = null;
let acknowledgeWatcherMessageDeliveryMock: jest.Mock;
let completePortalComposerCommandMock: jest.Mock<
  Promise<{ ok: true }>,
  [PortalChatComposerCommandResult]
>;
let getGitExecutableStatusMock: jest.Mock<Promise<GitExecutableStatus>, []>;
let loadPreferencesMock: jest.Mock<
  ReturnType<typeof window.api.loadPreferences>,
  Parameters<typeof window.api.loadPreferences>
>;
let loadCanopyCloudAccountMock: jest.Mock<
  Promise<CanopyCloudAccountPublicState>,
  []
>;
let notifyStartupUnlockedMock: jest.Mock<Promise<void>, []>;
let startCanopyGuestSessionMock: jest.Mock<
  Promise<CanopyCloudAccountPublicState>,
  [CanopyGuestConsent?]
>;
let startCanopyCloudOAuthLoginMock: jest.Mock<
  Promise<{
    status: unknown;
    account: CanopyCloudAccountPublicState;
    guestDataMerged?: boolean;
  }>,
  []
>;

function makeGitStatus(
  overrides: Partial<GitExecutableStatus> = {},
): GitExecutableStatus {
  return {
    platform: 'win32',
    required: true,
    ready: false,
    path: null,
    version: null,
    source: 'not-found',
    wingetAvailable: true,
    checkedAt: '2026-06-25T00:00:00.000Z',
    ...overrides,
  };
}

function makeCloudAccount(connected: boolean): CanopyCloudAccountPublicState {
  return {
    hasApiKey: connected,
    authMode: connected ? 'api_key' : null,
    credentialSource: connected ? 'manual' : null,
    capabilities: connected ? ['account-v1', 'teams-v1'] : [],
    account: connected
      ? {
          id: 'acct_123',
          name: 'Test User',
          email: 'test@example.com',
          role: 'DEVELOPER',
        }
      : undefined,
    storageAvailable: true,
  };
}

async function flushAsyncHandlerChain(): Promise<void> {
  for (let index = 0; index < 5; index += 1) {
    await Promise.resolve();
  }
}

function installWindowApi(): void {
  loadPreferencesMock = jest
    .fn<
      ReturnType<typeof window.api.loadPreferences>,
      Parameters<typeof window.api.loadPreferences>
    >()
    .mockResolvedValue({
      theme: 'system',
      colorMode: 'system',
      uiScale: 'medium',
      osNotifications: {},
      inAppNotifications: { placement: 'bottom-right' },
      onboardingCompleted: ['v1'],
      legalConsentAcceptedAt: '2026-07-06T00:00:00.000Z',
    });
  acknowledgeWatcherMessageDeliveryMock = jest
    .fn<Promise<void>, [unknown]>()
    .mockResolvedValue(undefined);
  completePortalComposerCommandMock = jest
    .fn<Promise<{ ok: true }>, [PortalChatComposerCommandResult]>()
    .mockResolvedValue({ ok: true });
  getGitExecutableStatusMock = jest
    .fn<Promise<GitExecutableStatus>, []>()
    .mockResolvedValue(makeGitStatus({ platform: 'darwin', required: false }));
  loadCanopyCloudAccountMock = jest
    .fn<Promise<CanopyCloudAccountPublicState>, []>()
    .mockResolvedValue(makeCloudAccount(false));
  notifyStartupUnlockedMock = jest
    .fn<Promise<void>, []>()
    .mockResolvedValue(undefined);
  startCanopyGuestSessionMock = jest
    .fn<Promise<CanopyCloudAccountPublicState>, [CanopyGuestConsent?]>()
    .mockResolvedValue(makeCloudAccount(true));
  startCanopyCloudOAuthLoginMock = jest
    .fn<
      Promise<{
        status: unknown;
        account: CanopyCloudAccountPublicState;
        guestDataMerged?: boolean;
      }>,
      []
    >()
    .mockResolvedValue({
      status: { authenticated: true },
      account: makeCloudAccount(true),
    });
  Object.defineProperty(window, 'api', {
    configurable: true,
    value: {
      experiments: {
        getSnapshot: () => Promise.resolve(labsSnapshot),
        setChoice: () => Promise.resolve(labsSnapshot),
        onSnapshotChanged: (): (() => void) => (): void => undefined,
      },
      loadPreferences: loadPreferencesMock,
      onPreferencesSynced: jest.fn((): (() => void) => (): void => undefined),
      loadCanopyCloudAccount: loadCanopyCloudAccountMock,
      startCanopyGuestSession: startCanopyGuestSessionMock,
      startCanopyCloudOAuthLogin: startCanopyCloudOAuthLoginMock,
      loadProjects: jest.fn().mockResolvedValue({ items: [], warnings: [] }),
      getResumeQueue: jest.fn().mockResolvedValue({
        version: 1,
        revision: 0,
        paused: false,
        entries: [],
      }),
      onResumeQueueChanged: jest.fn(
        (): (() => void) => (): undefined => undefined,
      ),
      listCloneJobs: jest.fn().mockResolvedValue([]),
      onCloneJobsChanged: jest.fn(
        (): (() => void) => (): undefined => undefined,
      ),
      getGitHubPermissions: jest.fn().mockResolvedValue({
        tokenAvailable: false,
        tokenType: 'unknown',
        scopes: [],
        permissions: [],
        canListRepos: false,
        error: null,
      }),
      notifyStartupUnlocked: notifyStartupUnlockedMock,
      // CAN-1929: `App` now mounts `useBillingLaneRuntimeSync`, which reads
      // provider auth + AI Credits availability so the synchronous default
      // resolver can see which billing lanes the user actually has. Signed-out
      // / no-credits is the neutral choice here — these specs assert
      // feature-flag gating, not billing, and this combination leaves lane
      // resolution with nothing to re-stamp.
      getClaudeAuthStatus: jest
        .fn()
        .mockResolvedValue({ authenticated: false, probeFailed: false }),
      getCodexAuthStatus: jest
        .fn()
        .mockResolvedValue({ authenticated: false, probeFailed: false }),
      loadNativeAiCreditsAvailability: jest.fn().mockResolvedValue(null),
      onDeepLinkShareOpen: jest.fn((): (() => void) => () => {}),
      onAutoArchiveCompleted: jest.fn((): (() => void) => () => {}),
      onDeepLinkRemoteControlOpen: jest.fn((): (() => void) => () => {}),
      onDeepLinkSettingsOpen: jest.fn((): (() => void) => () => {}),
      onDeepLinkPrivacyOptInOpen: jest.fn((): (() => void) => () => {}),
      onActivationCampaignNavigate: jest.fn(
        (listener: ActivationCampaignListener): (() => void) => {
          activationCampaignListener = listener;
          return (): void => {
            if (activationCampaignListener === listener) {
              activationCampaignListener = null;
            }
          };
        },
      ),
      getGitExecutableStatus: getGitExecutableStatusMock,
      redetectGitExecutable: jest
        .fn<Promise<GitExecutableStatus>, []>()
        .mockResolvedValue(
          makeGitStatus({ platform: 'darwin', required: false }),
        ),
      browseGitExecutable: jest
        .fn<Promise<GitExecutableStatus>, []>()
        .mockResolvedValue(
          makeGitStatus({ platform: 'darwin', required: false }),
        ),
      installGitWithWinget: jest
        .fn<Promise<GitExecutableStatus>, []>()
        .mockResolvedValue(makeGitStatus({ ready: true })),
      onGitInstallProgress: jest.fn<
        () => void,
        [(event: GitExecutableInstallProgress) => void]
      >((): (() => void) => (): void => undefined),
      browser: {
        openExternal: jest
          .fn<Promise<void>, [{ url: string }]>()
          .mockResolvedValue(undefined),
      },
      sharedContainers: {
        onReplicaChanged: jest.fn<() => void, [unknown]>(
          (): (() => void) => (): void => undefined,
        ),
        onPublicationChanged: jest.fn<() => void, [unknown]>(
          (): (() => void) => (): void => undefined,
        ),
      },
      workspaceContext: {
        get: jest.fn(
          (): Promise<WorkspaceContextState> =>
            Promise.resolve({
              context: { kind: 'personal' },
              revision: 0,
              organizations: [],
            }),
        ),
        set: jest.fn(
          (): Promise<WorkspaceContextState> =>
            Promise.resolve({
              context: { kind: 'personal' },
              revision: 1,
              organizations: [],
            }),
        ),
        onChanged: jest.fn((): (() => void) => (): void => undefined),
      },
      featureFlags: {
        getSnapshot: jest.fn<Promise<FeatureFlagSnapshot>, []>(
          (): Promise<FeatureFlagSnapshot> =>
            Promise.resolve(useFeatureFlagsStore.getState().snapshot),
        ),
        refreshContext: jest.fn<Promise<FeatureFlagSnapshot>, []>(
          (): Promise<FeatureFlagSnapshot> =>
            Promise.resolve(useFeatureFlagsStore.getState().snapshot),
        ),
        onSnapshotChanged: jest.fn<() => void, [FeatureFlagListener]>(
          (listener: FeatureFlagListener): (() => void) => {
            featureFlagListener = listener;
            return (): void => {
              if (featureFlagListener === listener) {
                featureFlagListener = null;
              }
            };
          },
        ),
      },
      appAdvisor: {
        getWindowState: jest
          .fn<Promise<{ open: boolean; focused: boolean }>, []>()
          .mockResolvedValue({ open: false, focused: false }),
        onWindowStateChanged: jest.fn<() => void, [unknown]>(
          (): (() => void) => (): void => undefined,
        ),
        acknowledgeWatcherMessageDelivery:
          acknowledgeWatcherMessageDeliveryMock,
      },
      chat: {
        onWindowCommand: jest.fn<
          () => void,
          [(command: ChatWindowCommand) => void]
        >((listener: (command: ChatWindowCommand) => void): (() => void) => {
          chatWindowCommandListener = listener;
          return (): void => {
            if (chatWindowCommandListener === listener) {
              chatWindowCommandListener = null;
            }
          };
        }),
        onPortalComposerCommand: jest.fn<
          () => void,
          [(request: PortalChatComposerRendererRequest) => void]
        >(
          (
            listener: (request: PortalChatComposerRendererRequest) => void,
          ): (() => void) => {
            portalComposerCommandListener = listener;
            return (): void => {
              if (portalComposerCommandListener === listener) {
                portalComposerCommandListener = null;
              }
            };
          },
        ),
        completePortalComposerCommand: completePortalComposerCommandMock,
      },
      pipelineEditor: {
        onToolRequest: jest.fn<() => void, [unknown]>(
          (): (() => void) => (): void => undefined,
        ),
        completeToolRequest: jest
          .fn<Promise<void>, [unknown]>()
          .mockResolvedValue(undefined),
      },
      slowActions: {
        loadSnapshot: jest
          .fn<Promise<{ records: [] }>, []>()
          .mockResolvedValue({ records: [] }),
        onEvent: jest.fn<() => void, [unknown]>(
          (): (() => void) => (): void => undefined,
        ),
        clear: jest.fn<Promise<void>, []>().mockResolvedValue(undefined),
      },
    },
  });
}

/** Sets the Claude Workers page flag on top of the suite's baseline snapshot. */
function setPageFlags(flags: { workers: boolean }): void {
  const current = useFeatureFlagsStore.getState().snapshot;
  useFeatureFlagsStore.getState().setSnapshot({
    ...current,
    values: {
      ...current.values,
      [CLIENT_FEATURE_FLAGS.canopyDesktopClaudeTuiWorkers.key]: flags.workers,
    },
  });
}

/** Lets lazy page chunks resolve and effects settle. */
async function settle(): Promise<void> {
  await act(async () => {
    for (let i = 0; i < 20; i += 1) {
      await Promise.resolve();
    }
    await new Promise<void>((resolve) => setTimeout(resolve, 0));
    for (let i = 0; i < 20; i += 1) {
      await Promise.resolve();
    }
  });
}

function setPortalFlag(enabled: boolean): void {
  useFeatureFlagsStore.getState().setSnapshot({
    ...getDefaultFeatureFlagSnapshot(),
    values: {
      ...getDefaultFeatureFlagSnapshot().values,
      [CLIENT_FEATURE_FLAGS.canopyPortalEnabled.key]: enabled,
      [CLIENT_FEATURE_FLAGS.canopySharedClaudeModelFable5.key]: false,
      // Keep the blocking Cloud sign-in gate off so these Portal-focused tests
      // render the main shell instead of the sign-in splash.
      [CLIENT_FEATURE_FLAGS.canopyCloudSignInRequired.key]: false,
    },
    status: 'ready',
    initialized: true,
    updatedAt: new Date().toISOString(),
    error: null,
  });
}

async function renderApp(): Promise<{
  container: HTMLElement;
  cleanup: () => void;
}> {
  const container = document.createElement('div');
  document.body.appendChild(container);
  let root: Root | null = null;

  await act(async () => {
    root = createRoot(container);
    root.render(<App />);
    for (let i = 0; i < 20; i += 1) {
      await Promise.resolve();
    }
    await new Promise<void>((resolve) => setTimeout(resolve, 0));
    for (let i = 0; i < 20; i += 1) {
      await Promise.resolve();
    }
  });

  return {
    container,
    cleanup: (): void => {
      act(() => {
        root?.unmount();
      });
      container.remove();
    },
  };
}

describe('App Canopy Portal feature flag gate', () => {
  const originalApiDescriptor = Object.getOwnPropertyDescriptor(window, 'api');
  const originalPlatformDescriptor = Object.getOwnPropertyDescriptor(
    window,
    'platform',
  );

  beforeEach(() => {
    initNavigationHistoryTrackingMock.mockClear();
    featureFlagListener = null;
    // The Labs page experiments are on, so their pages open (CAN-3678).
    labsSnapshot = makeTestLabsSnapshot({ experiments: pageExperimentsOn() });
    chatWindowCommandListener = null;
    portalComposerCommandListener = null;
    installWindowApi();
    Object.defineProperty(window, 'platform', {
      configurable: true,
      value: 'darwin',
    });
    useNavigationStore.setState({
      activePage: 'main',
      settingsOpen: false,
      commandPaletteOpen: false,
      appAdvisorQuickPromptOpen: false,
      fileSearchPaletteOpen: false,
      prPickerOpen: false,
      canopyPortalOpen: true,
      appAdvisorOpen: false,
      appAdvisorFocused: false,
    });
    useProjectsStore.setState({ hasHydratedProjects: true, projects: [] });
    useSidebarStore.setState({ hidden: false, persistedHidden: false });
    useSidebarPageHandoffStore.setState({ active: false });
    useChatStore.setState({
      selectedWorktree: null,
      worktreeChats: {},
      unreadWorktreeKeys: new Set(),
    });
    setPortalFlag(true);
  });

  afterEach(() => {
    resetLabsExperimentsStoreForTest();
    if (originalApiDescriptor) {
      Object.defineProperty(window, 'api', originalApiDescriptor);
    } else {
      Reflect.deleteProperty(window, 'api');
    }
    if (originalPlatformDescriptor) {
      Object.defineProperty(window, 'platform', originalPlatformDescriptor);
    } else {
      Reflect.deleteProperty(window, 'platform');
    }
  });

  it('routes campaign settings clicks to the destination they name', async () => {
    const openSettings = jest.fn();
    useNavigationStore.setState({ openSettings });
    jest.mocked(openCloudAccountSettings).mockClear();
    jest.mocked(openIntegrationSettings).mockClear();

    const rendered = await renderApp();
    try {
      act(() => {
        activationCampaignListener?.({
          campaignId: 'getting-started-sequence',
          destination: { kind: 'settings', section: 'account' },
        });
      });
      expect(openCloudAccountSettings).toHaveBeenCalledTimes(1);
      expect(openIntegrationSettings).not.toHaveBeenCalled();

      act(() => {
        activationCampaignListener?.({
          campaignId: 'getting-started-sequence',
          destination: {
            kind: 'settings',
            section: 'account',
            target: 'integrations',
          },
        });
      });
      expect(openIntegrationSettings).toHaveBeenCalledTimes(1);
      expect(openCloudAccountSettings).toHaveBeenCalledTimes(1);

      act(() => {
        activationCampaignListener?.({
          campaignId: 'getting-started-sequence',
          destination: { kind: 'settings', section: 'notifications' },
        });
      });
      expect(openSettings).toHaveBeenCalledWith('notifications');
      expect(openSettings).not.toHaveBeenCalledWith('account');
    } finally {
      rendered.cleanup();
    }
  });

  it('does not render the Portal modal when the feature flag is disabled', async () => {
    setPortalFlag(false);

    const rendered = await renderApp();
    try {
      expect(
        rendered.container.querySelector('[data-testid="canopy-portal-modal"]'),
      ).toBeNull();
      expect(useNavigationStore.getState().canopyPortalOpen).toBe(false);
    } finally {
      rendered.cleanup();
    }
  });

  it('keeps the inert main sidebar mounted for the Settings transition', async () => {
    useNavigationStore.setState({ settingsOpen: true });

    const rendered = await renderApp();
    try {
      expect(
        rendered.container.querySelector('[data-testid="settings-overlay"]'),
      ).not.toBeNull();
      expect(
        rendered.container.querySelector('[data-testid="sidebar"]'),
      ).not.toBeNull();
      const sidebarPage = rendered.container.querySelector(
        '[data-testid="app-sidebar-page"]',
      );
      expect(sidebarPage?.hasAttribute('inert')).toBe(true);
      expect(sidebarPage?.getAttribute('aria-hidden')).toBe('true');
      expect(sidebarPage?.getAttribute('data-page-active')).toBe('false');
      expect(sidebarPage?.className).not.toContain('app-sidebar-content');
      expect(
        rendered.container.querySelector('[data-testid="app-titlebar-corner"]'),
      ).toBeNull();

      const mainShell = rendered.container.querySelector(
        '[data-testid="app-main-shell"]',
      );
      expect(mainShell?.hasAttribute('inert')).toBe(true);
      expect(mainShell?.getAttribute('aria-hidden')).toBe('true');
      expect(mainShell?.className).toContain('invisible');
    } finally {
      rendered.cleanup();
    }
  });

  it('uses the inset window without a Labs opt-in', async () => {
    resetExperimentalFeaturesStoreForTest();

    const rendered = await renderApp();
    try {
      expect(
        rendered.container.querySelector('[data-window-layout="inset"]'),
      ).not.toBeNull();
    } finally {
      rendered.cleanup();
      resetExperimentalFeaturesStoreForTest();
    }
  });

  it('marks the inset window layout independently of Early access', async () => {
    resetExperimentalFeaturesStoreForTest();
    loadPreferencesMock.mockResolvedValue({
      theme: 'system',
      colorMode: 'system',
      uiScale: 'medium',
      osNotifications: {},
      inAppNotifications: { placement: 'bottom-right' },
      onboardingCompleted: ['v1'],
      legalConsentAcceptedAt: '2026-07-06T00:00:00.000Z',
    });
    labsSnapshot = makeTestLabsSnapshot({
      earlyAccess: false,
      experiments: [
        { id: 'inset-layout', requiresEarlyAccess: false, choice: true },
      ],
    });

    const rendered = await renderApp();
    try {
      expect(
        rendered.container.querySelectorAll('[data-window-layout="inset"]'),
      ).toHaveLength(1);
      expect(
        // New Task (the restored landing page) keeps the top bar row empty
        // above its card.
        rendered.container.querySelector(
          'main[data-main-frame="card-below-bar"]',
        ),
      ).not.toBeNull();
    } finally {
      rendered.cleanup();
      resetExperimentalFeaturesStoreForTest();
    }
  });

  it('hands off only the sidebar for an in-page secondary settings view', async () => {
    useSidebarPageHandoffStore.setState({ active: true });

    const rendered = await renderApp();
    try {
      expect(
        rendered.container
          .querySelector('[data-testid="sidebar"]')
          ?.getAttribute('data-sidebar-page-open'),
      ).toBe('true');
      expect(
        rendered.container.querySelector('[data-testid="app-titlebar-corner"]'),
      ).toBeNull();

      const sidebarPage = rendered.container.querySelector(
        '[data-testid="app-sidebar-page"]',
      );
      expect(sidebarPage?.hasAttribute('inert')).toBe(false);

      const mainShell = rendered.container.querySelector(
        '[data-testid="app-main-shell"]',
      );
      expect(mainShell?.hasAttribute('inert')).toBe(false);
      expect(mainShell?.className).not.toContain('invisible');
    } finally {
      rendered.cleanup();
    }
  });

  it('applies the active page replay classification on <main> (CAN-3119)', async () => {
    const rendered = await renderApp();
    try {
      const main = rendered.container.querySelector('main');
      expect(main).not.toBeNull();

      // The page host only keeps a dev page active when its real gate is on:
      // a development build plus this page's per-machine opt-in.
      Object.defineProperty(window, 'devInfo', {
        configurable: true,
        value: { isDev: true },
      });
      window.localStorage.setItem(HEADER_STATES_PAGE_STORAGE_KEY, '1');
      await act(async () => {
        useNavigationStore.setState({ activePage: 'header-states' });
        await Promise.resolve();
      });
      expect(
        NAVIGATION_PAGE_REPLAY_PRIVACY['header-states'] === 'blocked',
      ).toBe(true);
      expect(main?.classList.contains(POSTHOG_REPLAY_BLOCK_CLASS)).toBe(true);
      // The marker adds no layout of its own.
      expect(main?.className).toContain(
        'relative flex-1 min-w-0 overflow-auto',
      );

      await act(async () => {
        useNavigationStore.setState({ activePage: 'overview' });
        await Promise.resolve();
      });
      expect(NAVIGATION_PAGE_REPLAY_PRIVACY.overview).toBe('reviewed');
      expect(main?.classList.contains(POSTHOG_REPLAY_BLOCK_CLASS)).toBe(false);

      await act(async () => {
        useNavigationStore.setState({ activePage: 'main' });
        await Promise.resolve();
      });
      expect(main?.classList.contains(POSTHOG_REPLAY_BLOCK_CLASS)).toBe(false);
    } finally {
      rendered.cleanup();
      Reflect.deleteProperty(window, 'devInfo');
      window.localStorage.removeItem(HEADER_STATES_PAGE_STORAGE_KEY);
    }
  });

  describe('pages that are switched off (CAN-3661)', () => {
    const query = (container: HTMLElement, testId: string): Element | null =>
      container.querySelector(`[data-testid="${testId}"]`);

    it.each([
      {
        page: 'workers' as const,
        testId: 'workers-page',
        off: { workers: false },
      },
    ])(
      'moves to New task when $page is switched off while open',
      async ({ page, testId, off }) => {
        setPageFlags({ workers: true });
        const rendered = await renderApp();
        try {
          await act(async () => {
            useNavigationStore.getState().navigate(page);
            await Promise.resolve();
          });
          await settle();
          expect(useNavigationStore.getState().activePage).toBe(page);
          expect(query(rendered.container, testId)).not.toBeNull();

          await act(async () => {
            setPageFlags(off);
            await Promise.resolve();
          });
          await settle();

          expect(query(rendered.container, testId)).toBeNull();
          expect(useNavigationStore.getState().activePage).toBe('home');
          expect(query(rendered.container, 'home-page')).not.toBeNull();
          expect(query(rendered.container, 'overview-page')).toBeNull();
        } finally {
          rendered.cleanup();
        }
      },
    );

    it('removes the page content in the render that sees the flag flip, before the redirect', async () => {
      setPageFlags({ workers: true });
      const rendered = await renderApp();
      const originalNavigate = useNavigationStore.getState().navigate;
      try {
        await act(async () => {
          originalNavigate('workers');
          await Promise.resolve();
        });
        await settle();
        expect(query(rendered.container, 'workers-page')).not.toBeNull();

        // Hold the redirect back: only the render guard can hide the content.
        const heldNavigate = jest.fn();
        act(() => {
          useNavigationStore.setState({ navigate: heldNavigate });
        });
        act(() => {
          setPageFlags({ workers: false });
        });

        expect(useNavigationStore.getState().activePage).toBe('workers');
        expect(query(rendered.container, 'workers-page')).toBeNull();
        expect(query(rendered.container, 'home-page')).not.toBeNull();
        // The page frame follows the rendered page, not the refused one.
        expect(
          rendered.container
            .querySelector('[data-main-frame]')
            ?.getAttribute('data-main-frame'),
        ).toBe('card-below-bar');
        expect(heldNavigate).toHaveBeenCalledWith('home');
      } finally {
        useNavigationStore.setState({ navigate: originalNavigate });
        rendered.cleanup();
      }
    });

    it('never mounts a dev page whose gate is off', async () => {
      const rendered = await renderApp();
      try {
        await act(async () => {
          useNavigationStore.setState({ activePage: 'header-states' });
          await Promise.resolve();
        });
        await settle();

        expect(query(rendered.container, 'dev-pages')).toBeNull();
        expect(
          query(rendered.container, 'header-state-gallery-page'),
        ).toBeNull();
        expect(useNavigationStore.getState().activePage).toBe('home');
      } finally {
        rendered.cleanup();
      }
    });

    it('stays on New task when the page is switched back on', async () => {
      setPageFlags({ workers: true });
      const rendered = await renderApp();
      try {
        await act(async () => {
          useNavigationStore.getState().navigate('workers');
          await Promise.resolve();
        });
        await settle();
        await act(async () => {
          setPageFlags({ workers: false });
          await Promise.resolve();
        });
        await settle();
        expect(useNavigationStore.getState().activePage).toBe('home');

        await act(async () => {
          setPageFlags({ workers: true });
          await Promise.resolve();
        });
        await settle();

        expect(useNavigationStore.getState().activePage).toBe('home');
        expect(query(rendered.container, 'workers-page')).toBeNull();

        // Available again on request.
        await act(async () => {
          useNavigationStore.getState().navigate('workers');
          await Promise.resolve();
        });
        await settle();
        expect(query(rendered.container, 'workers-page')).not.toBeNull();
      } finally {
        rendered.cleanup();
      }
    });
  });

  it('hands the New Task seat over at the sidebar edge instead of fading it', async () => {
    const rendered = await renderApp();
    try {
      const corner = rendered.container.querySelector(
        '[data-testid="app-titlebar-corner"]',
      );
      const button = rendered.container.querySelector<HTMLButtonElement>(
        '[data-testid="titlebar-create-task"]',
      );

      expect(
        rendered.container.querySelector(
          '[data-testid="titlebar-quick-search"]',
        ),
      ).toBeNull();
      expect(corner?.className).toContain('overflow-visible');
      expect(corner?.className).toContain('electron-no-drag');
      expect(corner?.className).toContain('pointer-events-none');
      expect(corner?.className).not.toContain('electron-drag');
      // The seat rides a host span around the shared TitlebarIconButton, not
      // the button itself, so the button keeps the titlebar's color and
      // background transitions.
      const seat = button?.closest<HTMLElement>(
        '[data-testid="titlebar-create-task-fade"]',
      );
      expect(seat?.className).toContain('titlebar-create-task-seat');
      // Docked: the sidebar covers the seat. It is cut away by the sidebar's
      // own edge (width with its floor), not faded on a separate timer, so the
      // sidebar's Resources control and New Task never overlap or leave the
      // seat empty while the sidebar moves.
      const { width } = useSidebarStore.getState();
      expect(seat?.style.getPropertyValue('--titlebar-seat-edge')).toContain(
        `max(${width}px,`,
      );
      expect(seat?.style.getPropertyValue('--titlebar-seat-left')).not.toBe('');
      expect(seat?.className).not.toContain('opacity-0');
      expect(seat?.className).toContain('pointer-events-none');
      expect(button?.getAttribute('aria-hidden')).toBe('true');
      expect(button?.tabIndex).toBe(-1);

      act(() => useSidebarStore.setState({ hidden: true }));

      expect(seat?.style.getPropertyValue('--titlebar-seat-edge')).toBe('0px');
      expect(seat?.className).not.toContain('opacity-0');
      expect(seat?.className).toContain('pointer-events-auto');
      expect(button?.getAttribute('aria-hidden')).toBe('false');
      expect(button?.tabIndex).toBe(0);

      act(() => focusViaKeyboard(button));
      expect(document.body.querySelector('[role="tooltip"]')?.textContent).toBe(
        'New task',
      );

      // A hover preview brings the sidebar's own New Task back over the
      // seat, so the stand-in still fades out for the duration.
      act(() => useSidebarStore.setState({ previewing: true }));
      expect(seat?.className).toContain('opacity-0');
      expect(button?.getAttribute('aria-hidden')).toBe('true');
    } finally {
      rendered.cleanup();
    }
  });

  it('starts navigation history only after preferences restore the landing page', async () => {
    let resolvePreferences: ((value: unknown) => void) | undefined;
    loadPreferencesMock.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          resolvePreferences = resolve;
        }),
    );

    const rendered = await renderApp();
    try {
      expect(initNavigationHistoryTrackingMock).not.toHaveBeenCalled();

      await act(async () => {
        resolvePreferences?.({
          theme: 'system',
          colorMode: 'system',
          uiScale: 'medium',
          osNotifications: {},
          inAppNotifications: { placement: 'bottom-right' },
          onboardingCompleted: ['v1'],
          legalConsentAcceptedAt: '2026-07-06T00:00:00.000Z',
        });
        await flushAsyncHandlerChain();
      });

      expect(useNavigationStore.getState().activePage).toBe('home');
      expect(initNavigationHistoryTrackingMock).toHaveBeenCalledTimes(1);
    } finally {
      rendered.cleanup();
    }
  });

  it('closes an open Portal modal after a disabled feature-flag snapshot', async () => {
    const rendered = await renderApp();
    try {
      expect(
        rendered.container.querySelector('[data-testid="canopy-portal-modal"]'),
      ).not.toBeNull();

      await act(async () => {
        featureFlagListener?.({
          ...getDefaultFeatureFlagSnapshot(),
          values: {
            ...getDefaultFeatureFlagSnapshot().values,
            [CLIENT_FEATURE_FLAGS.canopyPortalEnabled.key]: false,
            [CLIENT_FEATURE_FLAGS.canopySharedClaudeModelFable5.key]: false,
            [CLIENT_FEATURE_FLAGS.canopyCloudSignInRequired.key]: false,
          },
          status: 'ready',
          initialized: true,
          updatedAt: new Date().toISOString(),
          error: null,
        });
        await Promise.resolve();
      });

      expect(useNavigationStore.getState().canopyPortalOpen).toBe(false);
      expect(
        rendered.container.querySelector('[data-testid="canopy-portal-modal"]'),
      ).toBeNull();
    } finally {
      rendered.cleanup();
    }
  });

  it('retries LaunchDarkly when the network comes back while flags are unavailable (CAN-3511)', async () => {
    const rendered = await renderApp();
    try {
      const refreshContext = jest.mocked(
        window.api.featureFlags.refreshContext,
      );
      refreshContext.mockClear();

      // Healthy snapshot: reconnecting must not cost a LaunchDarkly round trip.
      act(() => {
        window.dispatchEvent(new Event('online'));
      });
      expect(refreshContext).not.toHaveBeenCalled();

      await act(async () => {
        featureFlagListener?.({
          ...getDefaultFeatureFlagSnapshot(
            'error',
            'timed out',
            'launchdarkly_enabled_unavailable',
          ),
          updatedAt: new Date().toISOString(),
        });
        await Promise.resolve();
      });
      act(() => {
        window.dispatchEvent(new Event('online'));
      });

      expect(refreshContext).toHaveBeenCalledTimes(1);
    } finally {
      rendered.cleanup();
    }
  });

  it('stops listening for reconnects after unmount', async () => {
    const rendered = await renderApp();
    const refreshContext = jest.mocked(window.api.featureFlags.refreshContext);
    await act(async () => {
      featureFlagListener?.({
        ...getDefaultFeatureFlagSnapshot(
          'error',
          'timed out',
          'launchdarkly_enabled_unavailable',
        ),
        updatedAt: new Date().toISOString(),
      });
      await Promise.resolve();
    });
    rendered.cleanup();
    refreshContext.mockClear();

    window.dispatchEvent(new Event('online'));

    expect(refreshContext).not.toHaveBeenCalled();
  });

  it('does not unlock startup work while Windows Git is still required', async () => {
    Object.defineProperty(window, 'platform', {
      configurable: true,
      value: 'win32',
    });
    getGitExecutableStatusMock.mockResolvedValue(
      makeGitStatus({ required: true, ready: false }),
    );

    const rendered = await renderApp();
    try {
      expect(getGitExecutableStatusMock).toHaveBeenCalledTimes(1);
      expect(
        rendered.container.querySelector(
          '[data-testid="windows-git-required-screen"]',
        ),
      ).not.toBeNull();
      expect(notifyStartupUnlockedMock).not.toHaveBeenCalled();
    } finally {
      rendered.cleanup();
    }
  });

  it('keeps the remote file picker host mounted behind the Windows Git gate', async () => {
    // A window showing another computer forwards the gate's Browse to that
    // computer, which answers with a file picker this window must show.
    Object.defineProperty(window, 'platform', {
      configurable: true,
      value: 'win32',
    });
    getGitExecutableStatusMock.mockResolvedValue(
      makeGitStatus({ required: true, ready: false }),
    );

    const rendered = await renderApp();
    try {
      expect(
        rendered.container.querySelector(
          '[data-testid="windows-git-required-screen"]',
        ),
      ).not.toBeNull();
      expect(
        rendered.container.querySelector('[data-testid="remote-access-host"]'),
      ).not.toBeNull();
    } finally {
      rendered.cleanup();
    }
  });

  it('keeps startup locked after cloud sign-in until Windows Git is ready', async () => {
    Object.defineProperty(window, 'platform', {
      configurable: true,
      value: 'win32',
    });
    useNavigationStore.setState({ canopyPortalOpen: false });
    useFeatureFlagsStore.getState().setSnapshot({
      ...getDefaultFeatureFlagSnapshot(),
      values: {
        ...getDefaultFeatureFlagSnapshot().values,
        [CLIENT_FEATURE_FLAGS.canopyPortalEnabled.key]: true,
        [CLIENT_FEATURE_FLAGS.canopySharedClaudeModelFable5.key]: false,
        [CLIENT_FEATURE_FLAGS.canopyCloudSignInRequired.key]: true,
        // Guest mode off so this test exercises the classic blocking gate.
        [CLIENT_FEATURE_FLAGS.canopyGuestModeEnabled.key]: false,
      },
      status: 'ready',
      initialized: true,
      updatedAt: new Date().toISOString(),
      error: null,
    });
    loadPreferencesMock.mockResolvedValue({
      theme: 'system',
      colorMode: 'system',
      uiScale: 'medium',
      osNotifications: {},
      inAppNotifications: { placement: 'bottom-right' },
      onboardingCompleted: [],
      legalConsentAcceptedAt: '2026-07-06T00:00:00.000Z',
    });
    getGitExecutableStatusMock.mockResolvedValue(
      makeGitStatus({ required: true, ready: false }),
    );

    const rendered = await renderApp();
    try {
      expect(getGitExecutableStatusMock).not.toHaveBeenCalled();
      const connectButton = rendered.container.querySelector<HTMLButtonElement>(
        '[data-testid="cloud-sign-in-gate"]',
      );
      expect(connectButton).not.toBeNull();

      await act(async () => {
        connectButton?.querySelector<HTMLButtonElement>('button')?.click();
        await flushAsyncHandlerChain();
        await new Promise<void>((resolve) => setTimeout(resolve, 0));
        await flushAsyncHandlerChain();
      });

      expect(getGitExecutableStatusMock).toHaveBeenCalledTimes(1);
      expect(
        rendered.container.querySelector(
          '[data-testid="windows-git-required-screen"]',
        ),
      ).not.toBeNull();
      expect(notifyStartupUnlockedMock).not.toHaveBeenCalled();
    } finally {
      rendered.cleanup();
    }
  });

  it('keeps the required sign-in wall mounted after the account event until the auth flow completes', async () => {
    useNavigationStore.setState({ canopyPortalOpen: false });
    useFeatureFlagsStore.getState().setSnapshot({
      ...getDefaultFeatureFlagSnapshot(),
      values: {
        ...getDefaultFeatureFlagSnapshot().values,
        [CLIENT_FEATURE_FLAGS.canopyCloudSignInRequired.key]: true,
        [CLIENT_FEATURE_FLAGS.canopyGuestModeEnabled.key]: false,
      },
      status: 'ready',
      initialized: true,
      updatedAt: new Date().toISOString(),
      error: null,
    });

    const rendered = await renderApp();
    try {
      expect(
        rendered.container.querySelector('[data-testid="cloud-sign-in-gate"]'),
      ).not.toBeNull();

      loadCanopyCloudAccountMock.mockResolvedValue(makeCloudAccount(true));
      await act(async () => {
        window.dispatchEvent(new Event(CANOPY_CLOUD_ACCOUNT_CHANGED_EVENT));
        await flushAsyncHandlerChain();
      });

      expect(notifyStartupUnlockedMock).not.toHaveBeenCalled();

      // The account event happens before the one-time telemetry disclosure is
      // handled, so it must not unmount the wall (and its nested prompt).
      const gate = rendered.container.querySelector<HTMLButtonElement>(
        '[data-testid="cloud-sign-in-gate"]',
      );
      expect(gate).not.toBeNull();

      await act(async () => {
        gate?.querySelector<HTMLButtonElement>('button')?.click();
        await flushAsyncHandlerChain();
      });
      expect(
        rendered.container.querySelector('[data-testid="cloud-sign-in-gate"]'),
      ).toBeNull();
    } finally {
      rendered.cleanup();
    }
  });

  it('does not let a persisted guest satisfy the required sign-in wall', async () => {
    useNavigationStore.setState({ canopyPortalOpen: false });
    useFeatureFlagsStore.getState().setSnapshot({
      ...getDefaultFeatureFlagSnapshot(),
      values: {
        ...getDefaultFeatureFlagSnapshot().values,
        [CLIENT_FEATURE_FLAGS.canopyCloudSignInRequired.key]: true,
        [CLIENT_FEATURE_FLAGS.canopyGuestModeEnabled.key]: false,
      },
      status: 'ready',
      initialized: true,
      updatedAt: new Date().toISOString(),
      error: null,
    });
    loadCanopyCloudAccountMock.mockResolvedValue({
      ...makeCloudAccount(true),
      authMode: 'guest',
      credentialSource: 'guest',
    });

    const rendered = await renderApp();
    try {
      expect(
        rendered.container.querySelector('[data-testid="cloud-sign-in-gate"]'),
      ).not.toBeNull();
      expect(notifyStartupUnlockedMock).not.toHaveBeenCalled();
    } finally {
      rendered.cleanup();
    }
  });

  it('releases a latched sign-in wall when its panel settles on an existing connected account', async () => {
    useNavigationStore.setState({ canopyPortalOpen: false });
    useFeatureFlagsStore.getState().setSnapshot({
      ...getDefaultFeatureFlagSnapshot(),
      values: {
        ...getDefaultFeatureFlagSnapshot().values,
        [CLIENT_FEATURE_FLAGS.canopyCloudSignInRequired.key]: true,
        [CLIENT_FEATURE_FLAGS.canopyGuestModeEnabled.key]: false,
      },
      status: 'ready',
      initialized: true,
      updatedAt: new Date().toISOString(),
      error: null,
    });

    const rendered = await renderApp();
    try {
      const ready = rendered.container.querySelector<HTMLButtonElement>(
        '[data-testid="cloud-sign-in-gate-ready"]',
      );
      expect(ready).not.toBeNull();

      await act(async () => {
        ready?.click();
        await flushAsyncHandlerChain();
      });

      expect(
        rendered.container.querySelector('[data-testid="cloud-sign-in-gate"]'),
      ).toBeNull();
    } finally {
      rendered.cleanup();
    }
  });

  it('unlocks startup work after Windows Git is ready', async () => {
    Object.defineProperty(window, 'platform', {
      configurable: true,
      value: 'win32',
    });
    getGitExecutableStatusMock.mockResolvedValue(
      makeGitStatus({
        required: true,
        ready: true,
        path: 'C:\\Program Files\\Git\\cmd\\git.exe',
        version: '2.45.0',
      }),
    );

    const rendered = await renderApp();
    try {
      expect(getGitExecutableStatusMock).toHaveBeenCalledTimes(1);
      expect(notifyStartupUnlockedMock).toHaveBeenCalledTimes(1);
    } finally {
      rendered.cleanup();
    }
  });

  function setGuestGateSnapshot(): void {
    useFeatureFlagsStore.getState().setSnapshot({
      ...getDefaultFeatureFlagSnapshot(),
      values: {
        ...getDefaultFeatureFlagSnapshot().values,
        [CLIENT_FEATURE_FLAGS.canopyCloudSignInRequired.key]: true,
        [CLIENT_FEATURE_FLAGS.canopyGuestModeEnabled.key]: true,
      },
      status: 'ready',
      initialized: true,
      updatedAt: new Date().toISOString(),
      error: null,
    });
  }

  it('silently mints a guest and opens the shell when guest mode is on and disconnected (no consent screen)', async () => {
    useNavigationStore.setState({ canopyPortalOpen: false });
    setGuestGateSnapshot();
    // A successful silent mint connects the account, so the gate resolves to the
    // shell with no interstitial and no blocking sign-in gate.
    startCanopyGuestSessionMock.mockImplementation(() => {
      loadCanopyCloudAccountMock.mockResolvedValue(makeCloudAccount(true));
      return Promise.resolve(makeCloudAccount(true));
    });

    const rendered = await renderApp();
    try {
      expect(startCanopyGuestSessionMock).toHaveBeenCalled();
      expect(
        rendered.container.querySelector('[data-testid="cloud-sign-in-gate"]'),
      ).toBeNull();
      expect(
        rendered.container.querySelector('[data-testid="main-page"]'),
      ).not.toBeNull();
    } finally {
      rendered.cleanup();
    }
  });

  it('mints the silent guest session with recorded first-run consent', async () => {
    useNavigationStore.setState({ canopyPortalOpen: false });
    setGuestGateSnapshot();
    startCanopyGuestSessionMock.mockImplementation(() => {
      loadCanopyCloudAccountMock.mockResolvedValue(makeCloudAccount(true));
      return Promise.resolve(makeCloudAccount(true));
    });

    const rendered = await renderApp();
    try {
      expect(startCanopyGuestSessionMock).toHaveBeenCalled();
      const consentArg = startCanopyGuestSessionMock.mock.calls[0][0];
      expect(consentArg?.tosVersion).toBe(CONSENT_TOS_VERSION);
      expect(typeof consentArg?.acceptedAt).toBe('string');
    } finally {
      rendered.cleanup();
    }
  });

  it('silently mints a guest in production (sign-in not required, guest mode on)', async () => {
    useNavigationStore.setState({ canopyPortalOpen: false });
    // The production shape: cloud sign-in is NOT required (no forced wall), but
    // guest mode is on — a guest identity must still be minted so anon users are
    // synced without ever being forced to sign in.
    useFeatureFlagsStore.getState().setSnapshot({
      ...getDefaultFeatureFlagSnapshot(),
      values: {
        ...getDefaultFeatureFlagSnapshot().values,
        [CLIENT_FEATURE_FLAGS.canopyCloudSignInRequired.key]: false,
        [CLIENT_FEATURE_FLAGS.canopyGuestModeEnabled.key]: true,
      },
      status: 'ready',
      initialized: true,
      updatedAt: new Date().toISOString(),
      error: null,
    });
    startCanopyGuestSessionMock.mockImplementation(() => {
      loadCanopyCloudAccountMock.mockResolvedValue(makeCloudAccount(true));
      return Promise.resolve(makeCloudAccount(true));
    });

    const rendered = await renderApp();
    try {
      expect(startCanopyGuestSessionMock).toHaveBeenCalled();
      expect(
        rendered.container.querySelector('[data-testid="cloud-sign-in-gate"]'),
      ).toBeNull();
      expect(
        rendered.container.querySelector('[data-testid="main-page"]'),
      ).not.toBeNull();
    } finally {
      rendered.cleanup();
    }
  });

  it('opens the shell as a guest once consent has been recorded', async () => {
    useNavigationStore.setState({ canopyPortalOpen: false });
    loadPreferencesMock.mockResolvedValue({
      theme: 'system',
      colorMode: 'system',
      uiScale: 'medium',
      osNotifications: {},
      inAppNotifications: { placement: 'bottom-right' },
      onboardingCompleted: ['v1'],
      guestConsentAcceptedAt: '2026-07-06T00:00:00.000Z',
      guestConsentTosVersion: '2026-07-06',
      legalConsentAcceptedAt: '2026-07-06T00:00:00.000Z',
      legalConsentTosVersion: '2026-07-06',
    });
    setGuestGateSnapshot();

    const rendered = await renderApp();
    try {
      expect(
        rendered.container.querySelector('[data-testid="main-page"]'),
      ).not.toBeNull();
    } finally {
      rendered.cleanup();
    }
  });

  it('delivers main-window watcher commands without activating the destination worktree', async () => {
    let finishHydration: (() => void) | undefined;
    const hydrationWait = jest
      .spyOn(chatHydration, 'waitForWorktreeHydration')
      .mockImplementationOnce(
        () =>
          new Promise<void>((resolve) => {
            finishHydration = resolve;
          }),
      );
    const originalLoadTabsForTarget = useChatStore.getState().loadTabsForTarget;
    const originalSendMessage = useChatStore.getState().sendMessage;
    const originalSwitchTab = useChatStore.getState().switchTab;
    const originalSelectWorktree = useChatStore.getState().selectWorktree;
    const originalNavigate = useNavigationStore.getState().navigate;
    const loadTabsForTarget = jest.fn<Promise<void>, unknown[]>(() =>
      Promise.resolve(),
    );
    const sendMessage = jest.fn<Promise<void>, unknown[]>(() =>
      Promise.resolve(),
    );
    const switchTab = jest.fn<void, unknown[]>();
    const selectWorktree = jest.fn<void, unknown[]>();
    const navigate = jest.fn<void, unknown[]>();

    useChatStore.setState({
      selectedWorktree: {
        projectId: 'project-active',
        worktreeId: 'worktree-active',
      },
      loadTabsForTarget: loadTabsForTarget as never,
      sendMessage: sendMessage as never,
      switchTab: switchTab as never,
      selectWorktree: selectWorktree as never,
      worktreeChats: {
        'project-active/worktree-active': {
          activeTabId: 'active-tab',
          tabs: [
            {
              id: 'active-tab',
              title: 'Active tab',
              messages: [],
              status: 'idle',
              error: null,
              createdAt: new Date().toISOString(),
              queuedMessages: [],
              planMode: false,
              proposalMode: 'optional',
              thinkingLevel: 'high',
              modelConfig: { fastMode: false },
            } as never,
          ],
        },
        'project-target/worktree-target': {
          activeTabId: 'other-target-tab',
          tabs: [
            {
              id: 'other-target-tab',
              title: 'Other target tab',
              messages: [],
              status: 'idle',
              error: null,
              createdAt: new Date().toISOString(),
              queuedMessages: [],
              planMode: false,
              proposalMode: 'optional',
              thinkingLevel: 'high',
              modelConfig: { fastMode: false },
            } as never,
            {
              id: 'watcher-tab',
              title: 'Watcher target',
              messages: [],
              status: 'idle',
              error: null,
              createdAt: new Date().toISOString(),
              queuedMessages: [],
              planMode: false,
              proposalMode: 'optional',
              thinkingLevel: 'high',
              modelConfig: { fastMode: false },
            } as never,
          ],
        },
      },
    });

    const rendered = await renderApp();
    try {
      act(() => {
        useNavigationStore.setState({ navigate: navigate as never });
      });

      await act(async () => {
        chatWindowCommandListener?.({
          type: 'send_watcher_message',
          projectId: 'project-target',
          worktreeId: 'worktree-target',
          chatId: 'watcher-tab',
          watcherId: 'watcher-1',
          deliveryId: 'delivery-1',
          text: 'Canopy watcher fired.',
          hiddenContextText: '<system_instruction>watcher</system_instruction>',
          watcherFired: { kind: 'Pipeline completion (Deploy)' },
        });
        await flushAsyncHandlerChain();
      });

      expect(sendMessage).not.toHaveBeenCalled();
      await act(async () => {
        finishHydration?.();
        await flushAsyncHandlerChain();
      });
      expect(hydrationWait).toHaveBeenCalledWith(
        'project-target/worktree-target',
      );
      expect(loadTabsForTarget).toHaveBeenLastCalledWith(
        'project-target',
        'worktree-target',
      );
      expect(sendMessage).toHaveBeenCalledWith(
        'Canopy watcher fired.',
        undefined,
        {
          projectId: 'project-target',
          worktreeId: 'worktree-target',
          chatId: 'watcher-tab',
        },
        undefined,
        expect.objectContaining({
          hiddenContext: {
            kind: 'canopy-watcher-event',
            text: '<system_instruction>watcher</system_instruction>',
          },
          watcherFired: { kind: 'Pipeline completion (Deploy)' },
          watcherDeliveryId: 'delivery-1',
          throwOnDispatchFailure: true,
        }),
      );
      expect(acknowledgeWatcherMessageDeliveryMock).toHaveBeenCalledWith({
        watcherId: 'watcher-1',
        deliveryId: 'delivery-1',
        stage: 'completed',
        ok: true,
      });
      expect(selectWorktree).not.toHaveBeenCalled();
      expect(switchTab).not.toHaveBeenCalled();
      expect(navigate).not.toHaveBeenCalled();
      expect(useChatStore.getState().selectedWorktree).toEqual({
        projectId: 'project-active',
        worktreeId: 'worktree-active',
      });
      expect(
        useChatStore.getState().worktreeChats['project-target/worktree-target']
          ?.activeTabId,
      ).toBe('other-target-tab');
    } finally {
      hydrationWait.mockRestore();
      act(() => {
        useChatStore.setState({
          loadTabsForTarget: originalLoadTabsForTarget,
          sendMessage: originalSendMessage,
          switchTab: originalSwitchTab,
          selectWorktree: originalSelectWorktree,
        });
        useNavigationStore.setState({ navigate: originalNavigate });
      });
      rendered.cleanup();
    }
  });

  it('watcher delivery to the sentinel is refused', async () => {
    const originalLoadTabsForTarget = useChatStore.getState().loadTabsForTarget;
    const originalSendMessage = useChatStore.getState().sendMessage;
    const loadTabsForTarget = jest.fn<Promise<void>, unknown[]>(() =>
      Promise.resolve(),
    );
    const sendMessage = jest.fn<Promise<void>, unknown[]>(() =>
      Promise.resolve(),
    );
    useChatStore.setState({
      loadTabsForTarget: loadTabsForTarget as never,
      sendMessage: sendMessage as never,
    });

    const rendered = await renderApp();
    try {
      await act(async () => {
        chatWindowCommandListener?.({
          type: 'send_watcher_message',
          projectId: PLAN_EXPLORE_CHAT_PROJECT_ID,
          worktreeId: 'plan-legacy',
          chatId: 'watcher-tab',
          watcherId: 'watcher-legacy',
          deliveryId: 'delivery-legacy',
          text: 'Canopy watcher fired.',
        });
        await flushAsyncHandlerChain();
      });

      expect(loadTabsForTarget).not.toHaveBeenCalled();
      expect(sendMessage).not.toHaveBeenCalled();
      expect(acknowledgeWatcherMessageDeliveryMock).toHaveBeenCalledWith({
        watcherId: 'watcher-legacy',
        deliveryId: 'delivery-legacy',
        stage: 'completed',
        ok: false,
        error: 'Watcher destination chat is not available.',
      });
    } finally {
      act(() => {
        useChatStore.setState({
          loadTabsForTarget: originalLoadTabsForTarget,
          sendMessage: originalSendMessage,
        });
      });
      rendered.cleanup();
    }
  });

  it('deduplicates a retried main-window watcher delivery while the first send is pending', async () => {
    const originalLoadTabsForTarget = useChatStore.getState().loadTabsForTarget;
    const originalSendMessage = useChatStore.getState().sendMessage;
    let resolveSend: (() => void) | undefined;
    const loadTabsForTarget: typeof originalLoadTabsForTarget = jest.fn(() =>
      Promise.resolve(),
    );
    const sendMessage: typeof originalSendMessage = jest.fn(
      () =>
        new Promise<void>((resolve) => {
          resolveSend = resolve;
        }),
    );
    const watcherTab: ChatTab = {
      id: 'watcher-tab',
      title: 'Watcher target',
      messages: [],
      status: 'streaming',
      error: null,
      createdAt: new Date().toISOString(),
      queuedMessages: [],
      planMode: false,
      proposalMode: 'optional',
      thinkingLevel: 'high',
      modelConfig: { fastMode: false },
    };
    useChatStore.setState({
      loadTabsForTarget,
      sendMessage,
      worktreeChats: {
        'project-target/worktree-target': {
          activeTabId: 'watcher-tab',
          tabs: [watcherTab],
        },
      },
    });

    const rendered = await renderApp();
    const command: ChatWindowCommand = {
      type: 'send_watcher_message',
      projectId: 'project-target',
      worktreeId: 'worktree-target',
      chatId: 'watcher-tab',
      watcherId: 'watcher-retry',
      deliveryId: 'delivery-retry',
      text: 'Canopy watcher fired.',
    };
    try {
      act(() => {
        chatWindowCommandListener?.(command);
        chatWindowCommandListener?.(command);
      });
      await flushAsyncHandlerChain();
      expect(sendMessage).toHaveBeenCalledTimes(1);

      await act(async () => {
        resolveSend?.();
        await flushAsyncHandlerChain();
      });
      expect(sendMessage).toHaveBeenCalledTimes(1);
    } finally {
      act(() => {
        useChatStore.setState({
          loadTabsForTarget: originalLoadTabsForTarget,
          sendMessage: originalSendMessage,
        });
      });
      rendered.cleanup();
    }
  });

  it('applies a replayed Portal Cursor selection through the store like any other model', async () => {
    // The Portal adapter already ran the managed-runtime preflight and the
    // canonical `changeChatModel` IPC re-checks it, so the renderer forwards a
    // Cursor selection exactly like a Claude or Codex one.
    const originalLoad = useChatStore.getState().loadTabsForTarget;
    const originalSetModel = useChatStore.getState().setModelAndWait;
    const setModelAndWait: typeof originalSetModel = jest.fn((model) => {
      const key = 'project-target/worktree-target';
      const current = useChatStore.getState().worktreeChats[key];
      if (current && typeof model === 'string') {
        useChatStore.setState({
          worktreeChats: {
            ...useChatStore.getState().worktreeChats,
            [key]: {
              ...current,
              tabs: current.tabs.map((tab) =>
                tab.id === 'portal-tab' ? { ...tab, model } : tab,
              ),
            },
          },
        });
      }
      return Promise.resolve();
    });
    useChatStore.setState({
      loadTabsForTarget: jest.fn(() => Promise.resolve()),
      setModelAndWait,
    });
    const portalTab: ChatTab = {
      id: 'portal-tab',
      title: 'Portal target',
      messages: [],
      status: 'idle',
      error: null,
      createdAt: new Date().toISOString(),
      queuedMessages: [],
      planMode: false,
      proposalMode: 'optional',
      thinkingLevel: 'high',
      model: 'old-model',
      modelConfig: { fastMode: false },
      fastModeExplicit: false,
    };
    useChatStore.setState({
      worktreeChats: {
        'project-target/worktree-target': {
          activeTabId: 'portal-tab',
          tabs: [portalTab],
        },
      },
    });
    const rendered = await renderApp();
    try {
      await act(async () => {
        portalComposerCommandListener?.({
          requestId: 'cursor-replayed',
          command: {
            projectId: 'project-target',
            worktreeId: 'worktree-target',
            chatId: 'portal-tab',
            kind: 'model',
            model: 'cursor-default',
          },
        });
        await flushAsyncHandlerChain();
      });
      expect(setModelAndWait).toHaveBeenCalledWith('cursor-default', {
        projectId: 'project-target',
        worktreeId: 'worktree-target',
        chatId: 'portal-tab',
      });
      expect(completePortalComposerCommandMock).toHaveBeenCalledWith({
        requestId: 'cursor-replayed',
        ok: true,
      });
    } finally {
      act(() => {
        useChatStore.setState({
          loadTabsForTarget: originalLoad,
          setModelAndWait: originalSetModel,
        });
      });
      rendered.cleanup();
    }
  });

  it('acknowledges a portal model setter only after the async store change applies', async () => {
    const originalLoadTabsForTarget = useChatStore.getState().loadTabsForTarget;
    const originalSetModelAndWait = useChatStore.getState().setModelAndWait;
    const loadTabsForTarget: typeof originalLoadTabsForTarget = jest.fn(() =>
      Promise.resolve(),
    );
    let finishModelChange: (() => void) | undefined;
    const setModelAndWait: typeof originalSetModelAndWait = jest.fn(
      (model) =>
        new Promise((resolve) => {
          finishModelChange = (): void => {
            const key = 'project-target/worktree-target';
            const current = useChatStore.getState().worktreeChats[key];
            if (current && typeof model === 'string') {
              useChatStore.setState({
                worktreeChats: {
                  ...useChatStore.getState().worktreeChats,
                  [key]: {
                    ...current,
                    tabs: current.tabs.map((tab) =>
                      tab.id === 'portal-tab' ? { ...tab, model } : tab,
                    ),
                  },
                },
              });
            }
            resolve();
          };
        }),
    );
    const portalTab: ChatTab = {
      id: 'portal-tab',
      title: 'Portal target',
      messages: [],
      status: 'idle',
      error: null,
      createdAt: new Date().toISOString(),
      queuedMessages: [],
      planMode: false,
      proposalMode: 'optional',
      thinkingLevel: 'high',
      model: 'old-model',
      modelConfig: { fastMode: false },
      fastModeExplicit: false,
    };

    useChatStore.setState({
      loadTabsForTarget,
      setModelAndWait,
      worktreeChats: {
        'project-target/worktree-target': {
          activeTabId: 'portal-tab',
          tabs: [portalTab],
        },
      },
    });

    const rendered = await renderApp();
    try {
      await act(async () => {
        portalComposerCommandListener?.({
          requestId: 'setter-model',
          command: {
            projectId: 'project-target',
            worktreeId: 'worktree-target',
            chatId: 'portal-tab',
            kind: 'model',
            model: 'new-model',
          },
        });
        await flushAsyncHandlerChain();
      });

      expect(setModelAndWait).toHaveBeenCalledWith('new-model', {
        projectId: 'project-target',
        worktreeId: 'worktree-target',
        chatId: 'portal-tab',
      });
      expect(completePortalComposerCommandMock).not.toHaveBeenCalled();

      await act(async () => {
        finishModelChange?.();
        await flushAsyncHandlerChain();
      });

      expect(completePortalComposerCommandMock).toHaveBeenCalledWith({
        requestId: 'setter-model',
        ok: true,
      });
    } finally {
      act(() => {
        useChatStore.setState({
          loadTabsForTarget: originalLoadTabsForTarget,
          setModelAndWait: originalSetModelAndWait,
        });
      });
      rendered.cleanup();
    }
  });

  describe('Portal legacy Fast commands on an Ultra fast chat', () => {
    const TARGET = {
      projectId: 'project-target',
      worktreeId: 'worktree-target',
      chatId: 'portal-tab',
    };
    const ultraTab = (): ChatTab => ({
      id: 'portal-tab',
      title: 'Portal target',
      messages: [],
      status: 'idle',
      error: null,
      createdAt: new Date().toISOString(),
      queuedMessages: [],
      planMode: false,
      proposalMode: 'optional',
      thinkingLevel: 'high',
      providerType: 'codex',
      model: 'gpt-6-astra',
      modelConfig: {
        thinkingLevel: 'high',
        speed: 'ultrafast',
        fastMode: false,
      },
      fastModeExplicit: true,
    });
    const replaceSpeed = (speed: 'standard' | 'fast'): void => {
      const key = `${TARGET.projectId}/${TARGET.worktreeId}`;
      const current = useChatStore.getState().worktreeChats[key];
      if (!current) return;
      useChatStore.setState({
        worktreeChats: {
          ...useChatStore.getState().worktreeChats,
          [key]: {
            ...current,
            tabs: current.tabs.map((tab) =>
              tab.id === TARGET.chatId
                ? {
                    ...tab,
                    modelConfig: {
                      ...tab.modelConfig,
                      speed,
                      fastMode: speed === 'fast',
                    },
                  }
                : tab,
            ),
          },
        },
      });
    };
    const applyFastCommand = async (
      requestId: string,
      fastMode: boolean,
      setFastMode: ReturnType<typeof useChatStore.getState>['setFastMode'],
    ): Promise<void> => {
      const originalLoadTabsForTarget =
        useChatStore.getState().loadTabsForTarget;
      const originalSetFastMode = useChatStore.getState().setFastMode;
      useChatStore.setState({
        loadTabsForTarget: jest.fn(() => Promise.resolve()),
        setFastMode,
        worktreeChats: {
          [`${TARGET.projectId}/${TARGET.worktreeId}`]: {
            activeTabId: TARGET.chatId,
            tabs: [ultraTab()],
          },
        },
      });
      const rendered = await renderApp();
      try {
        await act(async () => {
          portalComposerCommandListener?.({
            requestId,
            command: { ...TARGET, kind: 'fast', fastMode },
          });
          await flushAsyncHandlerChain();
        });
      } finally {
        act(() => {
          useChatStore.setState({
            loadTabsForTarget: originalLoadTabsForTarget,
            setFastMode: originalSetFastMode,
          });
        });
        rendered.cleanup();
      }
    };

    it('refuses to acknowledge a Regular command that leaves Ultra fast in place', async () => {
      // Ultra fast projects `fastMode: false`, so comparing the boolean would
      // report the legacy Regular command as applied while the chat still
      // requests Ultra fast. The bridge must confirm the exact speed.
      const setFastMode = jest.fn(() => Promise.resolve());
      await applyFastCommand('regular-kept-ultra', false, setFastMode);

      expect(setFastMode).toHaveBeenCalledWith(false, TARGET);
      expect(completePortalComposerCommandMock).toHaveBeenCalledWith({
        requestId: 'regular-kept-ultra',
        ok: false,
        code: 'invalid_target',
        error: 'The composer change is not available for this chat.',
        retryable: false,
      });
    });

    it.each([
      [false, 'standard'],
      [true, 'fast'],
    ] as const)(
      'acknowledges fastMode %s once it replaces Ultra fast with %s',
      async (fastMode, speed) => {
        const setFastMode = jest.fn(() => {
          replaceSpeed(speed);
          return Promise.resolve();
        });
        await applyFastCommand(`replaced-${speed}`, fastMode, setFastMode);

        expect(setFastMode).toHaveBeenCalledWith(fastMode, TARGET);
        expect(completePortalComposerCommandMock).toHaveBeenCalledWith({
          requestId: `replaced-${speed}`,
          ok: true,
        });
      },
    );
  });

  it('returns a correlated failure when a portal setter target is missing', async () => {
    const originalLoadTabsForTarget = useChatStore.getState().loadTabsForTarget;
    const loadTabsForTarget: typeof originalLoadTabsForTarget = jest.fn(() =>
      Promise.resolve(),
    );
    useChatStore.setState({
      loadTabsForTarget,
      worktreeChats: {},
    });

    const rendered = await renderApp();
    try {
      await act(async () => {
        portalComposerCommandListener?.({
          requestId: 'setter-missing',
          command: {
            projectId: 'project-target',
            worktreeId: 'worktree-target',
            chatId: 'missing-tab',
            kind: 'fast',
            fastMode: true,
          },
        });
        await flushAsyncHandlerChain();
      });

      expect(completePortalComposerCommandMock).toHaveBeenCalledWith({
        requestId: 'setter-missing',
        ok: false,
        code: 'not_found',
        error: 'The target chat is no longer available.',
        retryable: false,
      });
    } finally {
      act(() => {
        useChatStore.setState({
          loadTabsForTarget: originalLoadTabsForTarget,
        });
      });
      rendered.cleanup();
    }
  });

  it('creates a new worktree chat tab for a portal create composer command (CAN-1233)', async () => {
    const originalLoadTabsForTarget = useChatStore.getState().loadTabsForTarget;
    const originalCreateTab = useChatStore.getState().createTab;
    const loadTabsForTarget = jest.fn<Promise<void>, unknown[]>(() =>
      Promise.resolve(),
    );
    const createTab = jest.fn<void, unknown[]>();

    useChatStore.setState({
      loadTabsForTarget: loadTabsForTarget as never,
      createTab: createTab as never,
      worktreeChats: {
        'project-target/worktree-target': {
          activeTabId: 'existing-tab',
          tabs: [
            {
              id: 'existing-tab',
              title: 'Existing tab',
              messages: [],
              status: 'idle',
              error: null,
              createdAt: new Date().toISOString(),
              queuedMessages: [],
              planMode: false,
              proposalMode: 'optional',
              thinkingLevel: 'high',
              modelConfig: { fastMode: false },
            } as never,
          ],
        },
      },
    });

    const rendered = await renderApp();
    try {
      // A create command with a brand-new id appends a tab with that exact id.
      await act(async () => {
        portalComposerCommandListener?.({
          projectId: 'project-target',
          worktreeId: 'worktree-target',
          chatId: 'portal-new-chat',
          kind: 'create',
        });
        await flushAsyncHandlerChain();
      });

      expect(loadTabsForTarget).toHaveBeenLastCalledWith(
        'project-target',
        'worktree-target',
      );
      expect(createTab).toHaveBeenCalledWith({
        projectId: 'project-target',
        worktreeId: 'worktree-target',
        id: 'portal-new-chat',
      });
      expect(completePortalComposerCommandMock).not.toHaveBeenCalled();

      // Idempotent: a create command for a tab id that already exists is a
      // no-op (command replay must not duplicate the tab).
      createTab.mockClear();
      await act(async () => {
        portalComposerCommandListener?.({
          projectId: 'project-target',
          worktreeId: 'worktree-target',
          chatId: 'existing-tab',
          kind: 'create',
        });
        await flushAsyncHandlerChain();
      });
      expect(createTab).not.toHaveBeenCalled();
    } finally {
      act(() => {
        useChatStore.setState({
          loadTabsForTarget: originalLoadTabsForTarget,
          createTab: originalCreateTab,
        });
      });
      rendered.cleanup();
    }
  });
});
