// Startup tests replace process.platform; native PTYs must stay behind a host mock.
jest.mock('../auth-terminal/manager', () => ({
  getAuthTerminalManager: jest.fn(() => ({ shutdown: jest.fn() })),
}));
jest.mock('../lib/interrupted-work-recovery', () => ({
  recoverInterruptedWorkAtStartup: jest.fn(() => Promise.resolve()),
}));
// Startup awaits this real-process reaper before admission; tests own it.
const mockRecoverCopilotAtStartup = jest.fn<Promise<void>, []>();
// Records when quit revokes Copilot runtimes; the real teardown still runs.
const mockCopilotRuntimesShutdown = jest.fn<void, []>();
jest.mock('../copilot/connection', () => {
  const actual = jest.requireActual<typeof CopilotConnectionModule>(
    '../copilot/connection',
  );
  return {
    ...actual,
    recoverCopilotAtStartup: (): Promise<void> => mockRecoverCopilotAtStartup(),
    shutdownCopilotRuntimes: (): Promise<void> => {
      mockCopilotRuntimesShutdown();
      return actual.shutdownCopilotRuntimes();
    },
  };
});
// Quit-preparation stages a test can fail; unset mocks run the real stage.
const mockFlushResumeQueue = jest.fn<Promise<void> | undefined, []>();
jest.mock('../services/resume-queue-host', () => {
  const actual = jest.requireActual<typeof ResumeQueueHostModule>(
    '../services/resume-queue-host',
  );
  return {
    ...actual,
    flushResumeQueue: (): Promise<void> =>
      mockFlushResumeQueue() ?? actual.flushResumeQueue(),
  };
});
const mockShutdownPendingTitles = jest.fn<Promise<void> | undefined, []>();
jest.mock('../ledger/pending-titles', () => {
  const actual = jest.requireActual<typeof PendingTitlesModule>(
    '../ledger/pending-titles',
  );
  return {
    ...actual,
    shutdownDesktopPendingTitleOrchestrator: (): Promise<void> =>
      mockShutdownPendingTitles() ??
      actual.shutdownDesktopPendingTitleOrchestrator(),
  };
});
import type * as CopilotConnectionModule from '../copilot/connection';
import type * as ResumeQueueHostModule from '../services/resume-queue-host';
import type * as PendingTitlesModule from '../ledger/pending-titles';
import type * as DefaultBrowserRegistrationModule from '../browser/default-browser-registration';
import type * as W5DaemonRecordStoreArmModule from '../e2e-fixtures/w5-daemon-record-store-arm';
import type { OrgProjectsCapabilityRefreshDeps } from '../services/org-projects-capability-refresh';
import type { WindowAccessors } from '../ipc';
import type { DesktopIpcEvent } from '../canopy-runtime/desktop-ipc-caller';
import type {
  RendererOriginControllerOptions,
  RendererWindowTarget,
} from '../renderer-origin/renderer-origin-controller';
import type * as WindowStateModule from '../lib/window-state';
import type * as SplitLockServiceModule from '../services/split-lock-service';
import type * as BackgroundPresenceModule from '../lifecycle/background-presence';
import type * as LedgerStorageHostModule from '../ledger/storage-host';
import type * as ConfigPathsModule from '@canopy/desktop-shared/pipelines/config-paths';
import type * as ProviderAuthStateModule from '../auth/provider-auth-state';
import type * as DesktopInstrumentationMainModule from '@canopy/desktop-instrumentation/electron/main';
import type { BrowserWindow, WebContents } from 'electron';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { BRAND } from '@canopy/brand/current';
import {
  IPC_CHANNELS,
  type AppAdvisorWindowCommand,
  type AutoArchiveNotification,
  type PreferencesData,
} from '@canopy/desktop-shared/types';
import { ASK_USER_TIMEOUT_MS } from '@canopy/desktop-shared/lib/canopy-injected-tools';
import { getDefaultFeatureFlagSnapshot } from '@canopy/protocol/feature-flags';
import { patchedSdkBridgeConfigFor } from '@canopy/desktop-instrumentation/electron/__tests__/patched-datadog-sdk';

const eventHandlers = new Map<string, (...args: unknown[]) => void>();
const MAIN_PROCESS_EVENTS = [
  'unhandledRejection',
  'uncaughtException',
  'SIGINT',
  'SIGTERM',
] as const;
const initialMainProcessListeners = new Map(
  MAIN_PROCESS_EVENTS.map((event) => [event, process.rawListeners(event)]),
);
const initialGlobalKeys = new Set(Reflect.ownKeys(globalThis));
const initialChromeDesktop = process.env.CHROME_DESKTOP;
const E2E_GLOBAL_SEAM = /^__CANOPY_E2E_/;

function trackRealTimers(): () => void {
  const timeouts = jest.spyOn(globalThis, 'setTimeout');
  const intervals = jest.spyOn(globalThis, 'setInterval');
  return (): void => {
    jest.useRealTimers();
    for (const spy of [timeouts, intervals]) {
      for (const result of spy.mock.results) {
        if (result.type === 'return') clearTimeout(result.value);
      }
      spy.mockRestore();
    }
  };
}

function removeE2eGlobalSeams(): void {
  for (const key of Reflect.ownKeys(globalThis)) {
    if (
      typeof key === 'string' &&
      E2E_GLOBAL_SEAM.test(key) &&
      !initialGlobalKeys.has(key)
    ) {
      Reflect.deleteProperty(globalThis, key);
    }
  }
}

const whenReadyMock = jest.fn(() => new Promise<void>(() => {}));
const appQuitMock = jest.fn();
const appGetLoginItemSettingsMock = jest.fn(() => ({
  openAtLogin: false,
  status: 'not-registered',
}));
const appSetLoginItemSettingsMock = jest.fn();
const appExitMock = jest.fn();
const showErrorBoxMock = jest.fn();
const appIsInApplicationsFolderMock = jest.fn(() => true);
const appMoveToApplicationsFolderMock = jest.fn(() => false);
const appSetPathMock = jest.fn();
const appCommandLineGetSwitchValueMock = jest.fn(() => '');
const appCommandLineAppendSwitchMock = jest.fn();
const setUsePlainTextEncryptionMock = jest.fn();
const collectDesktopCodexCapabilityGarbageMock = jest.fn(() =>
  Promise.resolve(),
);
const cleanupGatewayCompatibleCodexCatalogMock = jest.fn(() =>
  Promise.resolve(),
);

const drainMainProcessLoggingMock = jest.fn<Promise<unknown>, []>(() =>
  Promise.resolve(null),
);
const drainMainProcessLoggingBestEffortMock = jest.fn<
  Promise<unknown>,
  [number]
>(() => Promise.resolve(null));
const mockRemoteMachineWindows: { current: unknown[] } = { current: [] };
interface MockRemoteControlOptions {
  showMainWindow: () => void;
  isAppQuitting: () => boolean;
}
const mockInitializeRemoteControl = jest.fn<void, [MockRemoteControlOptions]>();
// Remote control pulls in its crypto, relay and window graph; startup only
// needs the entry points.
jest.mock('../remote-control/electron-remote-control', () => ({
  initializeRemoteControl: (options: MockRemoteControlOptions): void =>
    mockInitializeRemoteControl(options),
  getRemoteControlRuntime: (): { liveMachineWindows: () => unknown[] } => ({
    liveMachineWindows: (): unknown[] => mockRemoteMachineWindows.current,
  }),
}));
jest.mock('../remote-control/host/bridge-window', () => ({
  resolveRemoteBridgeSender: jest.fn(() => null),
}));
jest.mock('../lib/main-process-logging', () => ({
  drainMainProcessLogging: (): Promise<unknown> =>
    drainMainProcessLoggingMock(),
  drainMainProcessLoggingBestEffort: (timeoutMs: number): Promise<unknown> =>
    drainMainProcessLoggingBestEffortMock(timeoutMs),
  initializeMainProcessLogging: jest.fn(),
  logMainProcessError: jest.fn(),
  logMainProcessInfo: jest.fn(),
  logMainProcessWarn: jest.fn(),
}));
jest.mock('../codex/capability-store', () => ({
  collectDesktopCodexCapabilityGarbage:
    collectDesktopCodexCapabilityGarbageMock,
  getDesktopCodexCapabilityStore: jest.fn(),
}));
jest.mock('../codex/gateway-model-catalog', () => ({
  cleanupGatewayCompatibleCodexCatalog:
    cleanupGatewayCompatibleCodexCatalogMock,
}));
const mockDockSetIcon = jest.fn<void, [string]>();
const powerMonitorOnMock = jest.fn();
const powerMonitorRemoveListenerMock = jest.fn();
const showMessageBoxSyncMock = jest.fn(() => 1);
const getMediaAccessStatusMock = jest.fn(() => 'not-determined');
interface BrowserWindowOptionsUnderTest {
  title?: string;
  icon?: string;
  width?: number;
  minWidth?: number;
  minHeight?: number;
  show?: boolean;
  backgroundColor?: string;
  webPreferences?: {
    contextIsolation?: boolean;
    spellcheck?: boolean;
  };
}

type BrowserWindowStub = ReturnType<typeof createBrowserWindowStub>;

// Test-only global seams are accessed with Reflect because build defines are
// declared as ambient constants, not `globalThis` properties.

const browserWindowMock = jest.fn<
  BrowserWindowStub,
  [BrowserWindowOptionsUnderTest?]
>();
const advisorRenderers: BrowserWindowStub[] = [];
let configureAdvisorRenderer: (renderer: BrowserWindowStub) => void = () =>
  undefined;
function advisorRenderer(): BrowserWindowStub {
  const renderer = advisorRenderers.at(-1);
  if (!renderer) throw new Error('Expected App Advisor view renderer');
  return renderer;
}
const webContentsViewMock = jest.fn(() => {
  const renderer = createBrowserWindowStub();
  advisorRenderers.push(renderer);
  configureAdvisorRenderer(renderer);
  return {
    webContents: renderer.webContents,
    setBounds: jest.fn(),
    setVisible: jest.fn(),
    setBackgroundColor: jest.fn(),
  };
});
const getFocusedWindowMock = jest.fn<BrowserWindowStub | null, []>(() => null);
const getPrimaryDisplayMock = jest.fn(() => ({
  workArea: { x: 0, y: 0, width: 1920, height: 1080 },
}));
/** The display a window's persisted bounds land on (zoomed window minimums). */
const getDisplayMatchingMock = jest.fn(() => ({
  workArea: { x: 0, y: 0, width: 1920, height: 1080 },
}));
const pauseAllActivePipelineExecutionsMock = jest.fn();
const destroyAllSessionsMock = jest.fn();
const updateClaudeSessionIdleTimeoutMinutesMock = jest.fn();
const shutdownDelegationLifecycleMock = jest.fn(() => Promise.resolve());
const getAllActiveSessionInfosMock = jest.fn(
  (): Array<{
    projectId: string;
    worktreeId: string;
    turnActive: boolean;
    pendingMessageCount: number;
  }> => [],
);
const cancelAllDiscoveriesMock = jest.fn();
const stopAllOutputPollingMock = jest.fn();
const stopAllRunningHooksMock = jest.fn();
const stopAllRunningShellScriptsMock = jest.fn();
const discardAllStagedSessionImportsMock = jest.fn(() => Promise.resolve());
const discardStaleSessionImportArtifactsMock = jest.fn(() => Promise.resolve());
const stopWorktreeBranchWatchersMock = jest.fn();
const killAllTerminalsMock = jest.fn();
const shutdownAuthTerminalManagerMock = jest.fn();
const flushWorkspaceTargetTouchesMock = jest.fn(() => Promise.resolve());
const touchWorkspaceTargetMock = jest.fn<
  Promise<void>,
  [string, string, number]
>(() => Promise.resolve());
const touchWorkspaceTargetAfterCommitMock = jest.fn(() => Promise.resolve());
const touchActiveAutoArchiveTargetsMock = jest.fn(async () => {
  await Promise.all(
    getAllActiveSessionInfosMock().map((target) =>
      touchWorkspaceTargetMock(target.projectId, target.worktreeId, Date.now()),
    ),
  );
});
const setAutoArchiveResultListenerMock = jest.fn<
  void,
  [((notification: AutoArchiveNotification) => void) | null]
>();
const stopAutoArchiveMock = jest.fn(() => Promise.resolve());
const disposeAutoArchiveActivitySubscriptionsMock = jest.fn();
const startAutoArchiveSchedulerMock = jest.fn(() => ({
  stopScheduling: stopAutoArchiveMock,
  disposeActivitySubscriptions: disposeAutoArchiveActivitySubscriptionsMock,
}));
const markAllLiveTerminalsExitedMock = jest.fn();

type W5HostAdmissionUnderTest =
  | { kind: 'admitted' }
  | { kind: 'refused'; message: string }
  | { kind: 'failed' };
const admitDesktopW5HostMock = jest
  .fn<Promise<W5HostAdmissionUnderTest>, [string]>()
  .mockResolvedValue({ kind: 'admitted' });
// Real registration does file I/O, which microtask-only startup waits miss.
jest.mock('../lib/w5-host-admission', () => ({
  admitDesktopW5Host: (dataRoot: string): unknown =>
    admitDesktopW5HostMock(dataRoot),
  desktopW5HostAdmission: (): Promise<void> => Promise.resolve(),
  registerDesktopW5Root: (): Promise<{ kind: 'admitted' }> =>
    Promise.resolve({ kind: 'admitted' }),
}));
// GB12 (CAN-5543): the compiled gate (its legacy no-op is covered in
// w5-flip-handoff.test.ts) and the handoff it turns on.
let w5FlipCompiled = false;
jest.mock('../lib/w5-flip-gate', () => ({
  isW5DaemonFlipCompiled: (): boolean => w5FlipCompiled,
}));
const startW5FlipHandoffMock = jest.fn<Promise<void>, [unknown]>(() =>
  Promise.resolve(),
);
const disposeW5FlipHandoffMock = jest.fn<Promise<void>, []>(() =>
  Promise.resolve(),
);
const cancelPendingW5FlipHandoffMock = jest.fn<void, []>();
jest.mock('../canopy-runtime/w5-flip-handoff', () => ({
  startW5FlipHandoff: (input: unknown): Promise<void> =>
    startW5FlipHandoffMock(input),
  cancelPendingW5FlipHandoff: (): void => cancelPendingW5FlipHandoffMock(),
  disposeW5FlipHandoff: (): Promise<void> => disposeW5FlipHandoffMock(),
}));
jest.mock('../lib/workspace-activity', () => ({
  touchWorkspaceTarget: touchWorkspaceTargetMock,
  touchWorkspaceTargetAfterCommit: touchWorkspaceTargetAfterCommitMock,
  flushWorkspaceTargetTouches: flushWorkspaceTargetTouchesMock,
}));
jest.mock('../lib/auto-archive', () => ({
  setAutoArchiveResultListener: setAutoArchiveResultListenerMock,
  startAutoArchiveScheduler: startAutoArchiveSchedulerMock,
  touchActiveAutoArchiveTargets: touchActiveAutoArchiveTargetsMock,
}));
type UpdaterCleanupCallback = () => Promise<void>;
const startUpdaterMock = jest.fn<
  void,
  [() => unknown, UpdaterCleanupCallback?]
>();
const stopUpdaterMock = jest.fn();
const initializeObservabilityServiceMock = jest.fn();
const disposeObservabilityServiceMock = jest.fn();
const recordAppDiagnosticMock = jest.fn();
const flushObservabilityMock = jest.fn();
const subscribeObservabilityMock = jest.fn(() => (): void => undefined);
const recordSessionDiagnosticMock = jest.fn();
type CodexGatewayProxyDiagnosticSinkUnderTest = (record: unknown) => void;
const setCodexGatewayProxyDiagnosticSinkMock = jest.fn<
  void,
  [CodexGatewayProxyDiagnosticSinkUnderTest]
>();
const shutdownCodexGatewayProxyServiceMock = jest.fn();
const readPreferencesFileMock = jest.fn();
const writePreferencesFileMock = jest.fn();
const flushPreferencesWritesMock = jest.fn();
const startPreferencesGenerationStampMock = jest.fn(
  (): Promise<'present'> => Promise.resolve('present'),
);
const stopPreferencesGenerationStampMock = jest.fn();
const initializeOllamaServiceMock = jest.fn();
const shutdownOllamaServiceMock = jest.fn();
const shutdownPipelineAdvisorServiceMock = jest.fn();
const getLabsExperimentsServiceMock = jest.fn();
const initializeLabsExperimentsServiceMock = jest.fn();
const disposeLabsExperimentsServiceMock = jest.fn();
const initializeFeatureFlagServiceMock = jest.fn();
const disposeFeatureFlagServiceMock = jest.fn();
const startSharedContainerInboxWatcherMock = jest.fn();
const shutdownSharedContainerInboxWatcherMock = jest.fn();
const loadModelsFromPackageJsonMock = jest.fn();
const refreshModelsForFeatureFlagsMock = jest.fn();
const updateAiGatewayModelCatalogMock = jest.fn();
const hydrateAiGatewayModelCatalogMock = jest.fn();
const startAiGatewayModelCatalogMock = jest.fn();
const disposeAiGatewayModelCatalogMock = jest.fn();
const broadcastModelRegistryUpdatedMock = jest.fn();
let mockAiGatewayCatalogListener:
  | ((catalog: { version: 1; models: never[] }) => void | Promise<void>)
  | undefined;
let mockAiGatewayStatusListener:
  | ((status: 'loading' | 'ready' | 'failed') => void)
  | undefined;
const createAiGatewayModelCatalogServiceMock = jest.fn(
  (options: {
    onCatalog: (catalog: {
      version: 1;
      models: never[];
    }) => void | Promise<void>;
    onStatus?: (status: 'loading' | 'ready' | 'failed') => void;
  }) => {
    mockAiGatewayCatalogListener = options.onCatalog;
    mockAiGatewayStatusListener = options.onStatus;
    return {
      hydrate: hydrateAiGatewayModelCatalogMock,
      start: startAiGatewayModelCatalogMock,
      retry: jest.fn(() => Promise.resolve()),
      getStatus: jest.fn((): 'loading' => 'loading'),
      dispose: disposeAiGatewayModelCatalogMock,
    };
  },
);
const startOrgEnforcedSettingsSyncMock = jest.fn();
const installOrgProjectsCapabilityRefreshMock = jest.fn<
  () => void,
  [OrgProjectsCapabilityRefreshDeps]
>(() => (): void => undefined);
const stopOrgEnforcedSettingsSyncMock = jest.fn();
const getFeatureFlagSnapshotMock = jest.fn(() =>
  getDefaultFeatureFlagSnapshot(),
);
const isFeatureFlagEnabledMock = jest.fn<boolean, [string]>(() => false);
const onFeatureFlagSnapshotChangedMock = jest.fn<() => void, [unknown]>(
  (): (() => void) => (): void => undefined,
);
const setFeatureFlagDiagnosticRecorderMock = jest.fn<void, [unknown]>();
const uninstallFeatureFlagRecoveryTriggersMock = jest.fn();
const installFeatureFlagRecoveryTriggersMock = jest.fn<
  () => void,
  [unknown, { app: unknown; powerMonitor: unknown }]
>(() => uninstallFeatureFlagRecoveryTriggersMock);
const reconcileGitPendingWorktreesMock = jest.fn();
const sweepOrphanedMacosWorktreeDirectoriesMock = jest.fn();
const shutdownClaudeTerminalServiceMock = jest.fn(() => Promise.resolve());
const shutdownDesktopIntegrationServerMock = jest.fn(() => Promise.resolve());
const shutdownMcpHttpProxyMock = jest.fn(() => Promise.resolve());
const whenLedgerLifecycleIdleMock = jest.fn<Promise<void>, []>(() =>
  Promise.resolve(),
);
const shutdownLedgerStorageHostMock = jest.fn<Promise<void>, []>(() =>
  Promise.resolve(),
);
const shutdownVoiceServiceMock = jest.fn();
const stopCanopyPortalMock = jest.fn(() => Promise.resolve());
const resumeCanopyPortalIfPossibleMock = jest.fn(() => Promise.resolve());
const shutdownWakeLockServiceMock = jest.fn();
const setWakeLockEnabledMock = jest.fn();
const initializeResourceMonitorServiceMock = jest.fn();
const disposeResourceMonitorServiceMock = jest.fn();
const initializeDesktopInstrumentationMainMock = jest.fn<
  ReturnType<
    typeof DesktopInstrumentationMainModule.initializeDesktopInstrumentationMain
  >,
  Parameters<
    typeof DesktopInstrumentationMainModule.initializeDesktopInstrumentationMain
  >
>();
const setDesktopInstrumentationUserMock = jest.fn();
const flushDesktopInstrumentationMock = jest.fn();
const getStableAnonymousKeyMock = jest.fn<Promise<string>, []>();
const loadCanopyCloudAccountMock = jest.fn();
type AccountChangeListenerUnderTest = (
  entry: {
    authMode?: 'oauth' | 'api_key' | 'guest';
    credentialSource?: 'manual' | 'oauth_desktop' | 'guest';
    account?: { email: string };
  } | null,
) => void;
const subscribeCanopyCloudAccountChangesMock = jest.fn<
  () => void,
  [AccountChangeListenerUnderTest]
>((): (() => void) => (): void => undefined);
interface RuntimeIpcRegistration {
  resolveCaller?: (event: DesktopIpcEvent) => unknown;
}
const mockRegisterAllIpcHandlers = jest.fn<
  void,
  [WindowAccessors, RuntimeIpcRegistration?]
>();
const killAllBuildsMock = jest.fn(() => Promise.resolve());
const shutdownCodeGraphReadWorkersMock = jest.fn(() => Promise.resolve());
const shutdownCodeGraphBaseManagerMock = jest.fn(() => Promise.resolve());
const shutdownPipelineProcessHostMock = jest.fn(() => Promise.resolve());
const shutdownClaudeProcessHostMock = jest.fn(() => Promise.resolve());
const shutdownBackgroundHelperQueueMock = jest.fn();
const shutdownDesktopCanopyRuntimeMock = jest.fn(() => Promise.resolve());
const createDesktopRuntimeMock = jest.fn<
  { query: jest.Mock; shutdown: typeof shutdownDesktopCanopyRuntimeMock },
  [{ shutdownTimeoutMs: number; getChatStatePort: () => unknown }]
>(() => ({
  query: jest.fn(),
  shutdown: shutdownDesktopCanopyRuntimeMock,
}));
const cancelStartupBackgroundTasksMock = jest.fn();
const scheduleDeferredStartupBackgroundTasksMock = jest.fn<
  () => void,
  [() => unknown]
>(() => cancelStartupBackgroundTasksMock);
const disposeCuratedMcpRefreshMock = jest.fn();
const startCuratedMcpRefreshMock = jest.fn(() => disposeCuratedMcpRefreshMock);
const disposeOnboardingProfileSyncMock = jest.fn();
const startOnboardingProfileSyncMock = jest.fn(
  () => disposeOnboardingProfileSyncMock,
);
const migrateAppManagedChatWorkspacesMock = jest.fn();
const migrateAppAdvisorChatsToWorkEntriesMock = jest.fn();
const initializeAppAdvisorWorkspaceMock = jest.fn();
const createWorkEntryMock = jest.fn<
  Promise<{
    entry: {
      id: string;
      title: string;
      createdAt: string;
      chatCount: number;
    };
    reusedExistingEmpty: boolean;
  }>,
  [string, { id: string; createdAt: string; title?: string }]
>();
const listWorkEntriesMock = jest.fn();
const resolveWorkEntryForChatMock = jest.fn();
const readChatArchivesFileMock = jest.fn();
const readArchivedContainerManifestMock = jest.fn();
const migrateStandaloneChatToCoworkMock = jest.fn();
const loadCoworkMigrationMapCacheMock = jest.fn();
const migrateApprovalDefaultsToFullAccessMock = jest.fn();
const capturePreferenceMigrationSnapshotsMock = jest.fn();
const migrateChatSummaryModelSelectionMock = jest.fn();
const migrateClaudeWorkerModesToCanopyMock = jest.fn();
const migrateSidebarRemoteControlVisibleMock = jest.fn();
const migrateSidebarMorePagesToMainMock = jest.fn();
const migrateLocalMemoryDefaultOnMock = jest.fn();
const migrateLocalMemoryModelFromSummaryMock = jest.fn();
const migrateSidebarManualSortDefaultMock = jest.fn();
const migrateOpenAppLinksInBuiltInBrowserDefaultMock = jest.fn();
const refreshAgentModelsFromStoreMock = jest.fn();
const prewarmLoginShellPathMock = jest.fn(() => Promise.resolve());
const scheduleMissingBundledBinaryReportMock = jest.fn();
const mockIsCloseToTrayEnabled = jest.fn(() => false);
const mockDiscloseCloseToTray = jest.fn<boolean, [string]>(() => true);
const mockTrayOptions: {
  current: { onOpen: () => void; onQuit: () => void } | null;
} = { current: null };
const drainSplitTemporaryWorkspaceBackgroundPhasesMock = jest.fn(() =>
  Promise.resolve(),
);
const beginSplitTemporaryWorkspaceShutdownMock = jest.fn();

type PermissionRequestCallback = (granted: boolean) => void;
type PermissionRequestDetails = { mediaTypes?: string[] };
type PermissionRequestHandler = (
  webContents: unknown,
  permission: string,
  callback: PermissionRequestCallback,
  details: PermissionRequestDetails,
) => void | Promise<void>;

const MOCK_FILE_PAGE_URLS = [
  'file:///mock/out/renderer/index.html',
  'file:///mock/out/renderer/app-advisor.html',
];
const MOCK_SCHEME_PAGE_URLS = [
  'app-renderer://bundle/index.html',
  'app-renderer://bundle/app-advisor.html',
];
const mockRendererOrigin: {
  origin: 'file' | 'scheme';
  trusted: string[];
  fallingBack: boolean;
  options: RendererOriginControllerOptions | null;
} = {
  origin: 'file',
  trusted: MOCK_FILE_PAGE_URLS,
  fallingBack: false,
  options: null,
};
const mockRendererOriginPrepare = jest.fn<
  Promise<'file' | 'scheme'>,
  [boolean]
>(() => Promise.resolve(mockRendererOrigin.origin));
/** The off path: the controller hands the window to index.ts's `loadFile`. */
function mockLoadThroughController(
  target: RendererWindowTarget,
): Promise<void> {
  if (mockRendererOrigin.origin === 'scheme') return Promise.resolve();
  return mockRendererOrigin.options?.loadFile(target) ?? Promise.resolve();
}
const mockRendererOriginLoadWindow = jest.fn<
  Promise<void>,
  [RendererWindowTarget]
>(mockLoadThroughController);
const mockRendererOriginStartRecordProbe = jest.fn();
const mockRegisterRendererSchemePrivileges = jest.fn();
jest.mock('../renderer-origin/renderer-origin-controller', () => ({
  createRendererOriginController: jest.fn(
    (options: RendererOriginControllerOptions) => {
      mockRendererOrigin.options = options;
      return {
        startRecordProbe: mockRendererOriginStartRecordProbe,
        prepare: mockRendererOriginPrepare,
        current: (): 'file' | 'scheme' => mockRendererOrigin.origin,
        loadWindow: mockRendererOriginLoadWindow,
        trustedRendererPageUrls: (): string[] => mockRendererOrigin.trusted,
        fallbackInProgress: (): boolean => mockRendererOrigin.fallingBack,
        status: (): {
          active: boolean;
          fellBack: boolean;
          switchBackFailed: boolean;
        } => ({
          active: mockRendererOrigin.origin === 'scheme',
          fellBack: false,
          switchBackFailed: false,
        }),
        whenSettled: (): Promise<void> => Promise.resolve(),
      };
    },
  ),
}));
jest.mock('../renderer-origin/electron-renderer-origin', () => ({
  registerRendererSchemePrivileges: mockRegisterRendererSchemePrivileges,
  createElectronOriginStorageBridge: jest.fn(),
  registerElectronRendererSchemeHandler: jest.fn(),
}));

jest.mock('electron', () => ({
  safeStorage: {
    setUsePlainTextEncryption: setUsePlainTextEncryptionMock,
  },
  app: {
    isPackaged: false,
    isInApplicationsFolder: appIsInApplicationsFolderMock,
    moveToApplicationsFolder: appMoveToApplicationsFolderMock,
    whenReady: whenReadyMock,
    setName: jest.fn(),
    setPath: appSetPathMock,
    // Chromium switches are appended at import time, before `whenReady`.
    commandLine: {
      getSwitchValue: appCommandLineGetSwitchValueMock,
      appendSwitch: appCommandLineAppendSwitchMock,
    },
    // Deep-link plumbing (CAN-2361): the module scope acquires the
    // single-instance lock and registers the scheme handler at import time.
    requestSingleInstanceLock: jest.fn(() => true),
    setAsDefaultProtocolClient: jest.fn(),
    // Launch at sign-in (CAN-3449) reads and writes these only on request.
    getLoginItemSettings: appGetLoginItemSettingsMock,
    setLoginItemSettings: appSetLoginItemSettingsMock,
    on: jest.fn((event: string, handler: (...args: unknown[]) => void) => {
      eventHandlers.set(event, handler);
    }),
    removeListener: jest.fn(),
    quit: appQuitMock,
    exit: appExitMock,
    dock: {
      setIcon: mockDockSetIcon,
    },
  },
  shell: {
    openExternal: jest.fn(),
  },
  // The OS focus shortcut service (CAN-1963) wires its E2E trigger seam on
  // `ipcMain` and wraps `globalShortcut`; neither is exercised here beyond
  // registration.
  ipcMain: {
    on: jest.fn(),
    removeListener: jest.fn(),
    handle: jest.fn(),
    removeHandler: jest.fn(),
  },
  globalShortcut: {
    register: jest.fn(() => true),
    unregister: jest.fn(),
    unregisterAll: jest.fn(),
  },
  dialog: {
    showMessageBoxSync: showMessageBoxSyncMock,
    showErrorBox: showErrorBoxMock,
  },
  powerMonitor: {
    on: powerMonitorOnMock,
    removeListener: powerMonitorRemoveListenerMock,
  },
  systemPreferences: {
    getMediaAccessStatus: getMediaAccessStatusMock,
  },
  nativeTheme: {
    themeSource: 'system',
    shouldUseDarkColors: false,
  },
  BrowserWindow: Object.assign(browserWindowMock, {
    getAllWindows: jest.fn(() => []),
    getFocusedWindow: getFocusedWindowMock,
  }),
  WebContentsView: webContentsViewMock,
  screen: {
    getDisplayMatching: getDisplayMatchingMock,
    getPrimaryDisplay: getPrimaryDisplayMock,
  },
}));

jest.mock('@electron-toolkit/utils', () => ({
  electronApp: {
    setAppUserModelId: jest.fn(),
  },
  is: {
    dev: true,
  },
}));

jest.mock('@canopy/desktop-shared/pipelines/config-paths', () => {
  const actual = jest.requireActual<typeof ConfigPathsModule>(
    '@canopy/desktop-shared/pipelines/config-paths',
  );
  return {
    ...actual,
    prewarmLoginShellPath: prewarmLoginShellPathMock,
  };
});

// The real prewarm runs the provider CLI and a login shell on every reload.
jest.mock('../auth/provider-auth-state', () => ({
  ...jest.requireActual<typeof ProviderAuthStateModule>(
    '../auth/provider-auth-state',
  ),
  prewarmProviderNativeAuthStatus: jest.fn(),
}));

jest.mock('../lib/bundled-binary-report', () => ({
  scheduleMissingBundledBinaryReport: scheduleMissingBundledBinaryReportMock,
}));

jest.mock('../menu', () => ({
  installApplicationMenu: jest.fn(),
  attachWindowInputGuards: jest.fn(),
  attachInputGuardsToContents: jest.fn(),
}));

jest.mock('../lib/editable-context-menu', () => ({
  attachEditableContextMenu: jest.fn(),
  attachEditableContextMenuToContents: jest.fn(),
}));

jest.mock('../lib/link-context-menu', () => ({
  attachLinkContextMenu: jest.fn(),
  attachLinkContextMenuToContents: jest.fn(),
  isLinkBrowserTargetAvailable: jest.fn(() => false),
  setLinkBrowserTargetAvailable: jest.fn(),
  shouldOfferOpenInBrowser: jest.fn(() => false),
}));

jest.mock('../ipc', () => ({
  registerAllIpcHandlers: mockRegisterAllIpcHandlers,
}));

jest.mock('../pipelines/pipeline-execution-registry', () => ({
  pauseAllActivePipelineExecutions: pauseAllActivePipelineExecutionsMock,
}));

jest.mock('../pipelines', () => ({
  cancelAllActivePipelineExecutions: pauseAllActivePipelineExecutionsMock,
  registerExecutionHandlers: jest.fn(),
  registerPipelineHandlers: jest.fn(),
}));

jest.mock('../pipelines/process-host-runner', () => ({
  shutdownPipelineProcessHost: shutdownPipelineProcessHostMock,
}));
jest.mock('../agents/claude-process-host-runner', () => ({
  shutdownClaudeProcessHost: shutdownClaudeProcessHostMock,
}));

jest.mock('../pipelines/pipeline-advisor', () => ({
  getPipelineAdvisorService: jest.fn(() => ({
    shutdown: shutdownPipelineAdvisorServiceMock,
  })),
}));

jest.mock('../plugins', () => ({
  registerPluginHandlers: jest.fn(),
}));

jest.mock('../skills', () => ({
  registerSkillHandlers: jest.fn(),
}));

jest.mock('../agents/session-manager', () => ({
  destroyAllSessions: destroyAllSessionsMock,
  updateClaudeSessionIdleTimeoutMinutes:
    updateClaudeSessionIdleTimeoutMinutesMock,
  getAllActiveSessionInfos: getAllActiveSessionInfosMock,
  subscribeChatSessionActivity: jest.fn(() => jest.fn()),
  listLiveBackgroundTaskOwners: jest.fn(() => []),
  subscribeLiveBackgroundTasks: jest.fn(() => jest.fn()),
  hasActiveChatTurnsForProject: jest.fn(() => false),
}));

jest.mock('../agents/delegation/lifecycle', () => ({
  shutdownDelegationLifecycle: shutdownDelegationLifecycleMock,
}));

jest.mock('../ipc/worktree-discovery', () => ({
  cancelAllDiscoveries: cancelAllDiscoveriesMock,
}));

jest.mock('../lib/bg-output-poller', () => ({
  stopAllOutputPolling: stopAllOutputPollingMock,
}));

jest.mock('../lib/hook-runner', () => ({
  stopAllRunningHooks: stopAllRunningHooksMock,
  listActiveHookRunTargets: jest.fn(() => []),
  subscribeActiveHookRunsChanged: jest.fn(() => jest.fn()),
}));

jest.mock('../lib/script-runner', () => ({
  stopAllRunningShellScripts: stopAllRunningShellScriptsMock,
  listTrackedShellScripts: jest.fn(() => []),
  subscribeTrackedScriptsChanged: jest.fn(() => jest.fn()),
}));

jest.mock('../lib/session-transfer', () => ({
  discardAllStagedSessionImports: discardAllStagedSessionImportsMock,
  discardStaleSessionImportArtifacts: discardStaleSessionImportArtifactsMock,
}));

jest.mock('../lib/worktree-branch-watcher', () => ({
  startWorktreeBranchEnrollment: jest.fn(),
  startWorktreeBranchObserver: jest.fn(),
  stopWorktreeBranchWatchers: stopWorktreeBranchWatchersMock,
}));

jest.mock('../code-graph/build-runner', () => ({
  killAllBuilds: killAllBuildsMock,
}));

jest.mock('../code-graph/read-runner', () => ({
  shutdownCodeGraphReadWorkers: shutdownCodeGraphReadWorkersMock,
}));

jest.mock('../lib/code-graph-base-manager', () => ({
  shutdownCodeGraphBaseManager: shutdownCodeGraphBaseManagerMock,
}));

jest.mock('../lib/background-helper-queue', () => ({
  shutdownBackgroundHelperQueue: shutdownBackgroundHelperQueueMock,
}));
jest.mock('../canopy-runtime/desktop-runtime', () => ({
  createDesktopRuntime: createDesktopRuntimeMock,
}));

jest.mock('../lib/split-temporary-workspace', () => ({
  beginSplitTemporaryWorkspaceShutdown:
    beginSplitTemporaryWorkspaceShutdownMock,
  drainSplitTemporaryWorkspaceBackgroundPhases:
    drainSplitTemporaryWorkspaceBackgroundPhasesMock,
  isSplitTemporaryWorkspaceInFlight: jest.fn(() => false),
}));

jest.mock('../terminal/worker-terminal', () => ({
  workerTerminal: {
    killAll: killAllTerminalsMock,
    runningWorktrees: jest.fn(() => []),
    addEventListener: jest.fn(() => jest.fn()),
  },
}));

jest.mock('../auth-terminal/manager', () => ({
  getAuthTerminalManager: (): {
    shutdown: typeof shutdownAuthTerminalManagerMock;
  } => ({
    shutdown: shutdownAuthTerminalManagerMock,
  }),
}));

jest.mock('../terminal/persistence', () => ({
  terminalPersistenceStore: {
    markAllLiveTerminalsExited: markAllLiveTerminalsExitedMock,
  },
}));

jest.mock('../updater', () => ({
  startUpdater: startUpdaterMock,
  stopUpdater: stopUpdaterMock,
}));

jest.mock('../observability', () => ({
  initializeObservabilityService: initializeObservabilityServiceMock,
  getObservabilityService: jest.fn(() => ({
    dispose: disposeObservabilityServiceMock,
    recordAppDiagnostic: recordAppDiagnosticMock,
    recordSessionDiagnostic: recordSessionDiagnosticMock,
    flush: flushObservabilityMock,
    subscribe: subscribeObservabilityMock,
    enableTurnStateAudit: jest.fn(),
    observeTurnState: jest.fn(),
  })),
}));

jest.mock('../agents/codex-gateway-proxy-service', () => ({
  setCodexGatewayProxyDiagnosticSink: setCodexGatewayProxyDiagnosticSinkMock,
  getCodexGatewayProxyService: jest.fn(() => ({
    shutdown: shutdownCodexGatewayProxyServiceMock,
  })),
}));

jest.mock('../ollama', () => ({
  getOllamaService: jest.fn(() => ({
    initialize: initializeOllamaServiceMock,
    shutdown: shutdownOllamaServiceMock,
  })),
}));

jest.mock('../voice/service', () => ({
  getVoiceService: jest.fn(() => ({
    shutdown: shutdownVoiceServiceMock,
  })),
}));

jest.mock('../integration/claude-terminal-session-service', () => ({
  getClaudeTerminalSessionService: jest.fn(() => ({
    shutdown: shutdownClaudeTerminalServiceMock,
  })),
}));

jest.mock('../integration/desktop-integration-server', () => ({
  getDesktopIntegrationServer: jest.fn(() => ({
    shutdown: shutdownDesktopIntegrationServerMock,
  })),
}));

jest.mock('../mcp/http-proxy-service', () => ({
  getMcpHttpProxyService: jest.fn(() => ({
    shutdown: shutdownMcpHttpProxyMock,
  })),
}));

jest.mock('../portal/portal-session-manager', () => ({
  resumeCanopyPortalIfPossible: resumeCanopyPortalIfPossibleMock,
  stopCanopyPortal: stopCanopyPortalMock,
}));

// Runtime behavior has its own suite; startup tests own lifecycle ordering.
jest.mock('../services/labs-experiments-runtime', () => ({
  getLabsExperimentsService: getLabsExperimentsServiceMock,
  initializeLabsExperimentsService: initializeLabsExperimentsServiceMock,
  disposeLabsExperimentsService: disposeLabsExperimentsServiceMock,
}));

jest.mock('../feature-flags', () => ({
  initializeFeatureFlagService: initializeFeatureFlagServiceMock,
  disposeFeatureFlagService: disposeFeatureFlagServiceMock,
  installFeatureFlagRecoveryTriggers: installFeatureFlagRecoveryTriggersMock,
  getFeatureFlagService: jest.fn(() => ({
    getSnapshot: getFeatureFlagSnapshotMock,
    isEnabled: isFeatureFlagEnabledMock,
    onSnapshotChanged: onFeatureFlagSnapshotChangedMock,
    setDiagnosticRecorder: setFeatureFlagDiagnosticRecorderMock,
  })),
}));

jest.mock('../services/shared-container-inbox-watcher', () => ({
  getSharedContainerInboxWatcher: jest.fn(() => ({
    start: startSharedContainerInboxWatcherMock,
    shutdown: shutdownSharedContainerInboxWatcherMock,
  })),
}));

jest.mock('../lib/model-config', () => ({
  loadModelsFromPackageJson: loadModelsFromPackageJsonMock,
  refreshModelsForFeatureFlags: refreshModelsForFeatureFlagsMock,
  updateAiGatewayModelCatalog: updateAiGatewayModelCatalogMock,
}));

jest.mock('../canopy-cloud/config', () => ({
  getCanopyCloudBaseUrl: (): string => 'https://cloud.example.com',
}));

jest.mock('../ai-gateway-models/service', () => ({
  createAiGatewayModelCatalogService: createAiGatewayModelCatalogServiceMock,
}));

jest.mock('../models/model-registry', () => ({
  broadcastModelRegistryUpdated: broadcastModelRegistryUpdatedMock,
  initializeModelHarnessRegistry: jest.fn(() => Promise.resolve()),
  refreshModelHarnessAssignments: jest.fn(),
  modelHarnessAssignmentController: {
    load: jest.fn(() => Promise.resolve({ revision: 0, assignments: [] })),
    set: jest.fn(),
    reset: jest.fn(),
  },
}));

jest.mock('../services/org-enforced-settings', () => ({
  startOrgEnforcedSettingsSync: startOrgEnforcedSettingsSyncMock,
  stopOrgEnforcedSettingsSync: stopOrgEnforcedSettingsSyncMock,
}));

jest.mock('../services/org-projects-capability-refresh', () => ({
  installOrgProjectsCapabilityRefresh: installOrgProjectsCapabilityRefreshMock,
}));

jest.mock('../power/wake-lock-service', () => ({
  getWakeLockService: jest.fn(() => ({
    setEnabled: setWakeLockEnabledMock,
    shutdown: shutdownWakeLockServiceMock,
  })),
}));

jest.mock('../resource-monitor', () => ({
  initializeResourceMonitorService: initializeResourceMonitorServiceMock,
  disposeResourceMonitorService: disposeResourceMonitorServiceMock,
}));

jest.mock('../startup-background-tasks', () => ({
  scheduleDeferredStartupBackgroundTasks:
    scheduleDeferredStartupBackgroundTasksMock,
}));

jest.mock('../ledger/lifecycle', () => ({
  whenLedgerLifecycleIdle: whenLedgerLifecycleIdleMock,
}));

jest.mock('../ledger/storage-host', () => {
  const actual = jest.requireActual<typeof LedgerStorageHostModule>(
    '../ledger/storage-host',
  );
  return {
    ...actual,
    shutdownLedgerStorageHost: shutdownLedgerStorageHostMock,
  };
});

jest.mock('../mcp/refresh-scheduler', () => ({
  startCuratedMcpRefresh: startCuratedMcpRefreshMock,
}));

jest.mock('../services/onboarding-profile-sync-service', () => ({
  startOnboardingProfileSync: startOnboardingProfileSyncMock,
}));

jest.mock('../lib/app-managed-workspaces', () => ({
  migrateAppManagedChatWorkspaces: migrateAppManagedChatWorkspacesMock,
}));

jest.mock('../lib/app-advisor-work-entry-migration', () => ({
  migrateAppAdvisorChatsToWorkEntries: migrateAppAdvisorChatsToWorkEntriesMock,
}));

jest.mock('../lib/app-advisor-workspace', () => ({
  initializeAppAdvisorWorkspace: initializeAppAdvisorWorkspaceMock,
  loadAppAdvisorWorkspaceSettings: jest.fn(),
  saveAppAdvisorWorkspaceSettings: jest.fn(),
  readAppAdvisorClaudeMd: jest.fn(),
  saveAppAdvisorClaudeMd: jest.fn(),
}));

jest.mock('../lib/cowork-work-entries', () => ({
  setWorkEntryRegistryReconciler: jest.fn(),
  createWorkEntry: createWorkEntryMock,
  listWorkEntries: listWorkEntriesMock,
  resolveWorkEntryForChat: resolveWorkEntryForChatMock,
}));

jest.mock('../lib/chat-archives', () => ({
  readChatArchivesFile: readChatArchivesFileMock,
}));

jest.mock('../lib/archived-containers', () => ({
  readArchivedContainerManifest: readArchivedContainerManifestMock,
}));

jest.mock('../lib/cowork-migration', () => ({
  migrateStandaloneChatToCowork: migrateStandaloneChatToCoworkMock,
}));

jest.mock('../lib/cowork-migration-map', () => ({
  loadCoworkMigrationMapCache: loadCoworkMigrationMapCacheMock,
}));

jest.mock('../lib/preferences-migrations', () => ({
  capturePreferenceMigrationSnapshots: capturePreferenceMigrationSnapshotsMock,
  migrateApprovalDefaultsToFullAccess: migrateApprovalDefaultsToFullAccessMock,
  migrateChatSummaryModelSelection: migrateChatSummaryModelSelectionMock,
  migrateClaudeWorkerModesToCanopy: migrateClaudeWorkerModesToCanopyMock,
  migrateSidebarRemoteControlVisible: migrateSidebarRemoteControlVisibleMock,
  migrateSidebarMorePagesToMain: migrateSidebarMorePagesToMainMock,
  migrateLocalMemoryDefaultOn: migrateLocalMemoryDefaultOnMock,
  migrateLocalMemoryModelFromSummary: migrateLocalMemoryModelFromSummaryMock,
  migrateSidebarManualSortDefault: migrateSidebarManualSortDefaultMock,
  migrateOpenAppLinksInBuiltInBrowserDefault:
    migrateOpenAppLinksInBuiltInBrowserDefaultMock,
}));

jest.mock('@canopy/desktop-instrumentation/electron/main', () => ({
  initializePostHogMain: jest.fn(() =>
    Promise.resolve({
      enabled: false,
      provider: 'posthog',
      reason: 'disabled',
    }),
  ),
  initializeDesktopInstrumentationMain:
    initializeDesktopInstrumentationMainMock,
  createForeignCrashDumpFilter: jest.fn(() => jest.fn()),
  keepDesktopInstrumentationSessionAlive: jest.fn(),
  setDesktopInstrumentationUser: setDesktopInstrumentationUserMock,
  setDesktopPostHogOperationCaptureEnabled: jest.fn(),
  flushDesktopInstrumentation: flushDesktopInstrumentationMock,
}));

jest.mock('../lib/anonymous-id', () => ({
  getStablePostHogAnonymousKey: jest.fn(),
  getStableAnonymousKey: getStableAnonymousKeyMock,
}));

jest.mock('../lib/canopy-cloud-account-store', () => ({
  loadCanopyCloudAccount: loadCanopyCloudAccountMock,
  subscribeCanopyCloudAccountChanges: subscribeCanopyCloudAccountChangesMock,
  subscribeCanopyCloudAccountConfirmations: (): (() => void) => (): void =>
    undefined,
}));

// Carryover owns account subscriptions and persistence for the process lifetime.
const foreignActivityCarryoverServiceMock = {
  initialize: jest.fn(),
  shutdown: jest.fn(),
};
jest.mock('../services/foreign-activity-carryover-service', () => ({
  getForeignActivityCarryoverService:
    (): typeof foreignActivityCarryoverServiceMock =>
      foreignActivityCarryoverServiceMock,
}));

// The cloud inventory sync (CAN-2830) is a process-lifetime service with its
// own account-change subscription and timers; main's tests only care that it
// is started, gated and disposed, so it is mocked like every other service.
const desktopInventorySyncServiceMock = {
  start: jest.fn(),
  dispose: jest.fn(),
  setFeatureFlagEnabled: jest.fn(),
};
jest.mock('../services/desktop-inventory-sync-service', () => ({
  getDesktopInventorySyncService: (): typeof desktopInventorySyncServiceMock =>
    desktopInventorySyncServiceMock,
}));

jest.mock('../lib/preferences-store', () => ({
  // Not degraded: approval resolution fails closed when this is non-null.
  peekPreferencesLoadError: (): null => null,
  readPreferencesFile: readPreferencesFileMock,
  writePreferencesFile: writePreferencesFileMock,
  flushPreferencesWrites: flushPreferencesWritesMock,
  startPreferencesGenerationStamp: startPreferencesGenerationStampMock,
  stopPreferencesGenerationStamp: stopPreferencesGenerationStampMock,
}));

jest.mock('../ipc/preferences', () => ({
  registerPreferenceHandlers: jest.fn(),
}));

jest.mock('../lib/window-state', () => ({
  validateWindowBounds: jest.fn((bounds: unknown) => bounds),
}));

jest.mock('../lib/worktree-boot-recovery', () => ({
  reconcileGitPendingWorktrees: reconcileGitPendingWorktreesMock,
}));

jest.mock('../lib/macos-worktree-directory-cleanup', () => ({
  sweepOrphanedMacosWorktreeDirectories:
    sweepOrphanedMacosWorktreeDirectoriesMock,
}));

jest.mock('../lib/agent-models', () => ({
  refreshAgentModelsFromStore: refreshAgentModelsFromStoreMock,
}));

jest.mock('../lib/paths', () => ({
  getAgentModelsFilePath: jest.fn(() => '/mock/agent-models.json'),
  getPreferencesFilePath: jest.fn(() => '/mock/preferences.json'),
}));

jest.mock('../lifecycle/background-presence', () => {
  const actual = jest.requireActual<typeof BackgroundPresenceModule>(
    '../lifecycle/background-presence',
  );
  return {
    ...actual,
    discloseCloseToTray: (appName: string): boolean =>
      mockDiscloseCloseToTray(appName),
    setTrayOptions: (
      options: Parameters<typeof actual.setTrayOptions>[0],
    ): void => {
      mockTrayOptions.current = options;
      actual.setTrayOptions(options);
    },
    isCloseToTrayEnabled: (): boolean => mockIsCloseToTrayEnabled(),
  };
});

function waitForImmediate(): Promise<void> {
  return new Promise<void>((resolve) => {
    setImmediate(resolve);
  });
}

async function waitForAppReady(): Promise<void> {
  // Startup captures and applies preferences across several awaited phases.
  // Keep this microtask-only because some callers intentionally use fake
  // timers, and leave headroom for registration phases that also await.
  for (let index = 0; index < 100; index += 1) {
    await Promise.resolve();
  }
}

function setPlatform(platform: NodeJS.Platform): () => void {
  const originalPlatformDescriptor = Object.getOwnPropertyDescriptor(
    process,
    'platform',
  );
  Object.defineProperty(process, 'platform', {
    configurable: true,
    value: platform,
  });

  return (): void => {
    if (originalPlatformDescriptor) {
      Object.defineProperty(process, 'platform', originalPlatformDescriptor);
    }
  };
}

/**
 * Owns a committed quit's fire-and-forget cleanup. `drain` and `restore` run
 * in separate hooks so restoration never depends on cleanup settling.
 */
function createQuitTestScope(): {
  commit: (beginQuit: () => void) => void;
  drain: () => Promise<void>;
  restore: () => void;
} {
  const restorePlatform = setPlatform('linux');
  const originalQuit = appQuitMock.getMockImplementation();
  const originalExit = appExitMock.getMockImplementation();
  let completion: Promise<boolean> | undefined;
  let restored = false;

  return {
    commit(beginQuit): void {
      // Resolve failure as data so an exit before afterEach cannot reject unhandled.
      completion = new Promise<boolean>((resolve) => {
        appQuitMock.mockImplementation(() => resolve(true));
        appExitMock.mockImplementation(() => resolve(false));
      });
      try {
        beginQuit();
      } catch (error) {
        // A synchronous throw never reached the hook's fire-and-forget cleanup.
        completion = undefined;
        throw error;
      }
    },
    async drain(): Promise<void> {
      if (completion && !(await completion)) {
        throw new Error('Expected shutdown cleanup to quit, not exit');
      }
    },
    restore(): void {
      if (restored) return;
      restored = true;
      appQuitMock.mockImplementation(originalQuit);
      appExitMock.mockImplementation(originalExit);
      restorePlatform();
    },
  };
}

/** Resolves with how a committed quit ended, so tests await it, not turns. */
function captureShutdownOutcome(): {
  outcome: Promise<'exit' | 'quit'>;
  restore: () => void;
} {
  const originalQuit = appQuitMock.getMockImplementation();
  const originalExit = appExitMock.getMockImplementation();
  const outcome = new Promise<'exit' | 'quit'>((resolve) => {
    appQuitMock.mockImplementation(() => resolve('quit'));
    appExitMock.mockImplementation(() => resolve('exit'));
  });
  return {
    outcome,
    restore(): void {
      appQuitMock.mockImplementation(originalQuit);
      appExitMock.mockImplementation(originalExit);
    },
  };
}

function isWindowOpenHandler(
  value: unknown,
): value is (details: Electron.HandlerDetails) => unknown {
  return typeof value === 'function';
}

function createBrowserWindowStub(): {
  on: jest.Mock<void, [string, (...args: unknown[]) => void]>;
  removeListener: jest.Mock;
  contentView: {
    children: unknown[];
    addChildView: jest.Mock;
    removeChildView: jest.Mock;
  };
  getContentBounds: jest.Mock;
  isDestroyed: jest.Mock<boolean, []>;
  isMaximized: jest.Mock<boolean, []>;
  isFullScreen: jest.Mock<boolean, []>;
  isVisible: jest.Mock<boolean, []>;
  isFocused: jest.Mock<boolean, []>;
  isMinimized: jest.Mock<boolean, []>;
  getNormalBounds: jest.Mock<
    { x: number; y: number; width: number; height: number },
    []
  >;
  show: jest.Mock<void, []>;
  showInactive: jest.Mock<void, []>;
  hide: jest.Mock<void, []>;
  focus: jest.Mock<void, []>;
  restore: jest.Mock<void, []>;
  close: jest.Mock<void, []>;
  moveTop: jest.Mock<void, []>;
  loadURL: jest.Mock<void, [string]>;
  loadFile: jest.Mock<void, [string, { search?: string }?]>;
  windowHandlers: Map<string, (...args: unknown[]) => void>;
  webContentsHandlers: Map<string, (...args: unknown[]) => void>;
  webContentsOnceHandlers: Map<string, (...args: unknown[]) => void>;
  webContents: {
    focus: jest.Mock;
    isFocused: jest.Mock<boolean, []>;
    close: jest.Mock;
    getZoomFactor: jest.Mock<number, []>;
    executeJavaScript: jest.Mock<Promise<void>, [string]>;
    loadURL: jest.Mock<void, [string]>;
    loadFile: jest.Mock<void, [string, { search?: string }?]>;
    on: jest.Mock<void, [string, (...args: unknown[]) => void]>;
    once: jest.Mock<void, [string, (...args: unknown[]) => void]>;
    reload: jest.Mock<void, []>;
    isDestroyed: jest.Mock<boolean, []>;
    isCrashed: jest.Mock<boolean, []>;
    send: jest.Mock<void, [string, ...unknown[]]>;
    setWindowOpenHandler: jest.Mock<void, [unknown]>;
    mainFrame: {
      isDestroyed: jest.Mock<boolean, []>;
      detached: boolean;
    };
    session: {
      setPermissionRequestHandler: jest.Mock<void, [PermissionRequestHandler]>;
    };
  };
} {
  const windowHandlers = new Map<string, (...args: unknown[]) => void>();
  const webContentsHandlers = new Map<string, (...args: unknown[]) => void>();
  const webContentsOnceHandlers = new Map<
    string,
    (...args: unknown[]) => void
  >();

  const loadURL = jest.fn<void, [string]>();
  const loadFile = jest.fn<void, [string, { search?: string }?]>();
  return {
    removeListener: jest.fn(),
    contentView: {
      children: [],
      addChildView: jest.fn(),
      removeChildView: jest.fn(),
    },
    getContentBounds: jest.fn(() => ({ x: 0, y: 0, width: 1200, height: 800 })),
    on: jest.fn<void, [string, (...args: unknown[]) => void]>(
      (event, handler): void => {
        windowHandlers.set(event, handler);
      },
    ),
    isDestroyed: jest.fn<boolean, []>(() => false),
    isMaximized: jest.fn<boolean, []>(() => false),
    isFullScreen: jest.fn<boolean, []>(() => false),
    isVisible: jest.fn<boolean, []>(() => false),
    isFocused: jest.fn<boolean, []>(() => false),
    isMinimized: jest.fn<boolean, []>(() => false),
    getNormalBounds: jest.fn<
      { x: number; y: number; width: number; height: number },
      []
    >(() => ({ x: 10, y: 20, width: 1200, height: 800 })),
    show: jest.fn<void, []>(),
    showInactive: jest.fn<void, []>(),
    hide: jest.fn<void, []>(),
    focus: jest.fn<void, []>(),
    restore: jest.fn<void, []>(),
    close: jest.fn<void, []>(),
    moveTop: jest.fn<void, []>(),
    loadURL,
    loadFile,
    windowHandlers,
    webContentsHandlers,
    webContentsOnceHandlers,
    webContents: {
      focus: jest.fn(),
      isFocused: jest.fn<boolean, []>(() => false),
      close: jest.fn(),
      getZoomFactor: jest.fn<number, []>(() => 1),
      executeJavaScript: jest.fn<Promise<void>, [string]>(() =>
        Promise.resolve(),
      ),
      loadURL,
      loadFile,
      on: jest.fn<void, [string, (...args: unknown[]) => void]>(
        (event, handler): void => {
          webContentsHandlers.set(event, handler);
        },
      ),
      once: jest.fn<void, [string, (...args: unknown[]) => void]>(
        (event, handler): void => {
          webContentsOnceHandlers.set(event, handler);
        },
      ),
      reload: jest.fn<void, []>(),
      isDestroyed: jest.fn<boolean, []>(() => false),
      isCrashed: jest.fn<boolean, []>(() => false),
      send: jest.fn<void, [string, ...unknown[]]>(),
      setWindowOpenHandler: jest.fn<void, [unknown]>(),
      mainFrame: {
        isDestroyed: jest.fn<boolean, []>(() => false),
        detached: false,
      },
      session: {
        setPermissionRequestHandler: jest.fn<
          void,
          [PermissionRequestHandler]
        >(),
      },
    },
  };
}

function getPermissionRequestHandler(
  createdWindow: ReturnType<typeof createBrowserWindowStub> | undefined,
): PermissionRequestHandler {
  const handler =
    createdWindow?.webContents.session.setPermissionRequestHandler.mock
      .calls[0]?.[0];
  if (!handler) {
    throw new Error('Expected permission request handler to be registered');
  }
  return handler;
}

function getRegisteredWindowAccessors(): WindowAccessors {
  const accessors = mockRegisterAllIpcHandlers.mock.calls[0]?.[0];
  if (!accessors) {
    throw new Error('Expected IPC window accessors');
  }
  return accessors;
}

function getValidateWindowBoundsMock(): jest.MockedFunction<
  typeof WindowStateModule.validateWindowBounds
> {
  const windowStateModule = jest.requireMock<typeof WindowStateModule>(
    '../lib/window-state',
  );
  return jest.mocked(windowStateModule.validateWindowBounds);
}

describe('main process shutdown', () => {
  let releaseRealTimers: (() => void) | undefined;

  beforeEach(() => {
    mockRendererOrigin.origin = 'file';
    mockRendererOrigin.trusted = MOCK_FILE_PAGE_URLS;
    mockRendererOrigin.fallingBack = false;
    mockTrayOptions.current = null;
    mockRemoteMachineWindows.current = [];
    mockRendererOriginPrepare.mockImplementation(() =>
      Promise.resolve(mockRendererOrigin.origin),
    );
    mockRendererOriginLoadWindow.mockImplementation(mockLoadThroughController);
    jest.resetModules();
    jest.clearAllMocks();
    advisorRenderers.length = 0;
    configureAdvisorRenderer = (): void => undefined;
    Reflect.deleteProperty(globalThis, '__CANOPY_RELEASE_FLAVOR__');
    eventHandlers.clear();
    whenReadyMock.mockImplementation(() => new Promise<void>(() => {}));
    appIsInApplicationsFolderMock.mockReturnValue(true);
    appMoveToApplicationsFolderMock.mockReturnValue(false);
    showMessageBoxSyncMock.mockReturnValue(1);
    getMediaAccessStatusMock.mockReturnValue('not-determined');
    powerMonitorOnMock.mockReset();
    powerMonitorRemoveListenerMock.mockReset();
    getAllActiveSessionInfosMock.mockReturnValue([]);
    browserWindowMock.mockImplementation(() => createBrowserWindowStub());
    getPrimaryDisplayMock.mockReturnValue({
      workArea: { x: 0, y: 0, width: 1920, height: 1080 },
    });
    getValidateWindowBoundsMock().mockImplementation((bounds) => bounds);
    initializeObservabilityServiceMock.mockResolvedValue(undefined);
    subscribeObservabilityMock.mockReturnValue((): void => undefined);
    initializeOllamaServiceMock.mockResolvedValue(undefined);
    migrateAppManagedChatWorkspacesMock.mockResolvedValue(undefined);
    migrateAppAdvisorChatsToWorkEntriesMock.mockResolvedValue(undefined);
    initializeAppAdvisorWorkspaceMock.mockResolvedValue(undefined);
    createWorkEntryMock.mockImplementation(
      (_projectId: string, options: { id: string; createdAt: string }) =>
        Promise.resolve({
          entry: {
            id: options.id,
            title: 'New chat',
            createdAt: options.createdAt,
            chatCount: 0,
          },
          reusedExistingEmpty: false,
        }),
    );
    resolveWorkEntryForChatMock.mockResolvedValue({
      entryId: 'entry-1',
      archivedInEntryId: null,
    });
    readChatArchivesFileMock.mockResolvedValue({ version: 1, archived: [] });
    readArchivedContainerManifestMock.mockResolvedValue({
      version: 1,
      id: 'archive-1',
    });
    migrateStandaloneChatToCoworkMock.mockResolvedValue(undefined);
    loadCoworkMigrationMapCacheMock.mockResolvedValue(undefined);
    migrateApprovalDefaultsToFullAccessMock.mockResolvedValue(undefined);
    capturePreferenceMigrationSnapshotsMock.mockResolvedValue({
      chatSummaryModelSelection: {
        hasPersistedPreferences: true,
        model: 'claude-haiku-4-5-20251001',
        marker: true,
      },
      localMemoryModel: {
        hasPersistedPreferences: true,
        localMemoryModelSetByUser: false,
        summaryModel: 'claude-haiku-4-5-20251001',
      },
    });
    migrateLocalMemoryModelFromSummaryMock.mockResolvedValue(undefined);
    migrateChatSummaryModelSelectionMock.mockResolvedValue(undefined);
    migrateClaudeWorkerModesToCanopyMock.mockResolvedValue(undefined);
    migrateSidebarRemoteControlVisibleMock.mockResolvedValue(undefined);
    migrateSidebarMorePagesToMainMock.mockResolvedValue(undefined);
    migrateLocalMemoryDefaultOnMock.mockResolvedValue(undefined);
    migrateSidebarManualSortDefaultMock.mockResolvedValue(undefined);
    migrateOpenAppLinksInBuiltInBrowserDefaultMock.mockResolvedValue(undefined);
    mockRecoverCopilotAtStartup.mockReset();
    mockRecoverCopilotAtStartup.mockResolvedValue(undefined);
    refreshAgentModelsFromStoreMock.mockResolvedValue(undefined);
    hydrateAiGatewayModelCatalogMock.mockResolvedValue(undefined);
    broadcastModelRegistryUpdatedMock.mockResolvedValue(undefined);
    mockAiGatewayCatalogListener = undefined;
    mockAiGatewayStatusListener = undefined;
    initializeLabsExperimentsServiceMock.mockResolvedValue(undefined);
    disposeLabsExperimentsServiceMock.mockResolvedValue(undefined);
    initializeFeatureFlagServiceMock.mockResolvedValue(undefined);
    disposeFeatureFlagServiceMock.mockResolvedValue(undefined);
    drainSplitTemporaryWorkspaceBackgroundPhasesMock.mockResolvedValue();
    isFeatureFlagEnabledMock.mockReturnValue(false);
    reconcileGitPendingWorktreesMock.mockResolvedValue(undefined);
    sweepOrphanedMacosWorktreeDirectoriesMock.mockResolvedValue(undefined);
    flushObservabilityMock.mockResolvedValue(undefined);
    initializeDesktopInstrumentationMainMock.mockResolvedValue({
      enabled: false,
      provider: 'datadog',
      reason: 'disabled',
    });
    getStableAnonymousKeyMock.mockResolvedValue(
      '11111111-2222-4333-8444-555555555555',
    );
    loadCanopyCloudAccountMock.mockResolvedValue(null);
    flushDesktopInstrumentationMock.mockResolvedValue(undefined);
    pauseAllActivePipelineExecutionsMock.mockResolvedValue(undefined);
    appExitMock.mockReset();
    shutdownDesktopCanopyRuntimeMock.mockResolvedValue(undefined);
    flushPreferencesWritesMock.mockResolvedValue(undefined);
    readPreferencesFileMock.mockResolvedValue({
      theme: 'default',
      windowBounds: null,
      windowMaximized: false,
      windowFullScreen: false,
      appAdvisorDialogBounds: null,
      ollamaServerPort: 11534,
    });
    writePreferencesFileMock.mockResolvedValue({
      windowBounds: null,
      windowMaximized: false,
      windowFullScreen: false,
      appAdvisorDialogBounds: null,
      ollamaServerPort: 11534,
    });
    mockIsCloseToTrayEnabled.mockReturnValue(false);
    mockDiscloseCloseToTray.mockReturnValue(true);
    releaseRealTimers = trackRealTimers();
  });

  afterEach(async () => {
    if (initialChromeDesktop === undefined) delete process.env.CHROME_DESKTOP;
    else process.env.CHROME_DESKTOP = initialChromeDesktop;
    // Jest yields no macrotask between tests, so startup parked on I/O keeps
    // each test's whole module graph alive; consecutive startup tests then
    // exhaust CI's 4 GB heap. Real timers first: a fake setImmediate never fires.
    jest.useRealTimers();
    await waitForImmediate();
    releaseRealTimers?.();
    releaseRealTimers = undefined;
    removeE2eGlobalSeams();
    for (const event of MAIN_PROCESS_EVENTS) {
      const initialListeners = initialMainProcessListeners.get(event) ?? [];
      for (const listener of process.rawListeners(event)) {
        if (!initialListeners.includes(listener)) {
          process.removeListener(
            event,
            listener as (...args: unknown[]) => void,
          );
        }
      }
    }
  });

  it('uses the padded amber dev icon for macOS development windows and dock', async () => {
    const restorePlatform = setPlatform('darwin');
    whenReadyMock.mockResolvedValue(undefined);
    const createdWindowOptions: BrowserWindowOptionsUnderTest[] = [];
    browserWindowMock.mockImplementation((options) => {
      createdWindowOptions.push(options ?? {});
      return createBrowserWindowStub();
    });

    try {
      await import('../index');
      await waitForAppReady();

      const expectedIconPath = join(
        process.cwd(),
        'apps/desktop-app/dev-resources/icon-dev-256.png',
      );
      expect(createdWindowOptions[0]?.icon).toBe(expectedIconPath);
      expect(mockDockSetIcon).toHaveBeenCalledWith(expectedIconPath);
    } finally {
      restorePlatform();
    }
  });

  it('applies the saved Claude idle timeout before creating the initial window', async () => {
    whenReadyMock.mockResolvedValue(undefined);
    readPreferencesFileMock.mockResolvedValue({
      claudeSessionIdleTimeoutMinutes: 7,
    });

    await import('../index');
    await waitForAppReady();

    expect(updateClaudeSessionIdleTimeoutMinutesMock).toHaveBeenCalledWith(7);
    expect(browserWindowMock).toHaveBeenCalled();
    expect(
      updateClaudeSessionIdleTimeoutMinutesMock.mock.invocationCallOrder[0],
    ).toBeLessThan(browserWindowMock.mock.invocationCallOrder[0]);
  });

  it('exits before any startup work while data maintenance holds the data folder', async () => {
    const message = 'Data maintenance is running. Try again when it finishes.';
    admitDesktopW5HostMock.mockResolvedValueOnce({ kind: 'refused', message });
    const flushed: Array<() => void> = [];
    const isFlushCallback = (value: unknown): value is () => void =>
      typeof value === 'function';
    const stderrWrite = jest
      .spyOn(process.stderr, 'write')
      .mockImplementation((_chunk, callback?: unknown): boolean => {
        if (isFlushCallback(callback)) flushed.push(callback);
        return true;
      });
    whenReadyMock.mockResolvedValue(undefined);
    try {
      await import('../index');
      await waitForAppReady();

      expect(admitDesktopW5HostMock).toHaveBeenCalledTimes(1);
      expect(stderrWrite).toHaveBeenCalledWith(
        `${message}\n`,
        expect.any(Function),
      );
      expect(showErrorBoxMock).toHaveBeenCalledWith(
        expect.stringMatching(/^Couldn't open \S/),
        message,
      );
      // The message must reach stderr before the process goes.
      expect(appExitMock).not.toHaveBeenCalled();
      flushed.forEach((flush) => flush());
      expect(appExitMock).toHaveBeenCalledTimes(1);
      expect(appExitMock).toHaveBeenCalledWith(1);
      expect(browserWindowMock).not.toHaveBeenCalled();
      expect(startAutoArchiveSchedulerMock).not.toHaveBeenCalled();
    } finally {
      stderrWrite.mockRestore();
    }
  });

  it('exits after a bounded wait when stderr never flushes the refusal', async () => {
    jest.useFakeTimers({
      doNotFake: ['setImmediate', 'nextTick', 'queueMicrotask'],
    });
    admitDesktopW5HostMock.mockResolvedValueOnce({
      kind: 'refused',
      message: 'Data maintenance is running. Try again when it finishes.',
    });
    const stderrWrite = jest
      .spyOn(process.stderr, 'write')
      .mockImplementation((): boolean => false);
    whenReadyMock.mockResolvedValue(undefined);
    try {
      await import('../index');
      await waitForAppReady();

      expect(stderrWrite).toHaveBeenCalledWith(
        expect.stringContaining('Data maintenance is running.'),
        expect.any(Function),
      );
      jest.advanceTimersByTime(999);
      expect(appExitMock).not.toHaveBeenCalled();
      jest.advanceTimersByTime(1);
      expect(appExitMock).toHaveBeenCalledTimes(1);
      expect(appExitMock).toHaveBeenCalledWith(1);
      expect(browserWindowMock).not.toHaveBeenCalled();
    } finally {
      stderrWrite.mockRestore();
      jest.useRealTimers();
    }
  });

  it('starts when W5 host registration fails for any other reason', async () => {
    admitDesktopW5HostMock.mockResolvedValueOnce({ kind: 'failed' });
    whenReadyMock.mockResolvedValue(undefined);

    await import('../index');
    await waitForAppReady();

    expect(appExitMock).not.toHaveBeenCalled();
    expect(showErrorBoxMock).not.toHaveBeenCalled();
    expect(browserWindowMock).toHaveBeenCalled();
  });

  describe('E2E W5 store selection at main startup', () => {
    const originalArm = process.env.CANOPY_PERFORMANCE_W5_STORE;
    const originalE2e: unknown = Reflect.get(globalThis, '__CANOPY_E2E__');

    beforeEach(() => {
      Reflect.set(globalThis, '__CANOPY_E2E__', true);
      whenReadyMock.mockResolvedValue(undefined);
    });

    afterEach(() => {
      w5FlipCompiled = false;
      if (originalArm === undefined)
        delete process.env.CANOPY_PERFORMANCE_W5_STORE;
      else process.env.CANOPY_PERFORMANCE_W5_STORE = originalArm;
      if (originalE2e === undefined)
        Reflect.deleteProperty(globalThis, '__CANOPY_E2E__');
      else Reflect.set(globalThis, '__CANOPY_E2E__', originalE2e);
    });

    it.each(['in-process', 'daemon-record-port'])(
      'refuses an explicit %s request on a flip build before opening a window',
      async (arm) => {
        process.env.CANOPY_PERFORMANCE_W5_STORE = arm;
        w5FlipCompiled = true;
        const armModule = jest.requireActual<
          typeof W5DaemonRecordStoreArmModule
        >('../e2e-fixtures/w5-daemon-record-store-arm');
        const start = jest.spyOn(armModule, 'startW5StoreArm');
        const isFlushCallback = (value: unknown): value is () => void =>
          typeof value === 'function';
        const stderrWrite = jest
          .spyOn(process.stderr, 'write')
          .mockImplementation((_chunk, callback?: unknown): boolean => {
            if (isFlushCallback(callback)) callback();
            return true;
          });
        try {
          await import('../index');
          await waitForAppReady();

          expect(start).toHaveBeenCalledWith(arm);
          const started: unknown = await start.mock.results[0]?.value;
          if (
            typeof started !== 'object' ||
            started === null ||
            !('refusal' in started)
          ) {
            throw new Error('Expected the startup arm to refuse the launch');
          }
          expect(started.refusal).toContain('cannot run on a W5 flip build');
          expect(stderrWrite).toHaveBeenCalledWith(
            expect.stringContaining('cannot run on a W5 flip build'),
            expect.any(Function),
          );
          expect(appExitMock).toHaveBeenCalledWith(1);
          expect(browserWindowMock).not.toHaveBeenCalled();
          expect(startAutoArchiveSchedulerMock).not.toHaveBeenCalled();
        } finally {
          start.mockRestore();
          stderrWrite.mockRestore();
        }
      },
    );

    it('validates an explicit in-process request on a legacy build and continues without an installed arm', async () => {
      process.env.CANOPY_PERFORMANCE_W5_STORE = 'in-process';
      const armModule = jest.requireActual<typeof W5DaemonRecordStoreArmModule>(
        '../e2e-fixtures/w5-daemon-record-store-arm',
      );
      const start = jest.spyOn(armModule, 'startW5StoreArm');
      try {
        await import('../index');
        await waitForAppReady();

        expect(start).toHaveBeenCalledWith('in-process');
        await expect(start.mock.results[0]?.value).resolves.toEqual({
          handle: null,
        });
        expect(appExitMock).not.toHaveBeenCalled();
        expect(browserWindowMock).toHaveBeenCalled();
      } finally {
        start.mockRestore();
      }
    });

    it.each([
      { e2e: true, arm: undefined },
      { e2e: true, arm: '' },
      { e2e: false, arm: 'daemon-record-port' },
    ])(
      'does not start an arm for E2E=$e2e, selection=$arm',
      async ({ e2e, arm }) => {
        Reflect.set(globalThis, '__CANOPY_E2E__', e2e);
        if (arm === undefined) delete process.env.CANOPY_PERFORMANCE_W5_STORE;
        else process.env.CANOPY_PERFORMANCE_W5_STORE = arm;
        const armModule = jest.requireActual<
          typeof W5DaemonRecordStoreArmModule
        >('../e2e-fixtures/w5-daemon-record-store-arm');
        const start = jest.spyOn(armModule, 'startW5StoreArm');
        try {
          await import('../index');
          await waitForAppReady();

          expect(start).not.toHaveBeenCalled();
          expect(appExitMock).not.toHaveBeenCalled();
          expect(browserWindowMock).toHaveBeenCalled();
        } finally {
          start.mockRestore();
        }
      },
    );
  });

  describe('the W5 flip launch (GB12)', () => {
    afterEach(() => {
      w5FlipCompiled = false;
    });

    it.each(['admitted', 'failed'] as const)(
      'starts the handoff after W11 admission (%s) and before any later startup',
      async (kind) => {
        admitDesktopW5HostMock.mockResolvedValueOnce({ kind });
        // Startup goes on while the handoff is pending (Q3(b)).
        startW5FlipHandoffMock.mockReturnValueOnce(new Promise(() => {}));
        whenReadyMock.mockResolvedValue(undefined);
        await import('../index');
        await waitForAppReady();
        expect(startW5FlipHandoffMock).toHaveBeenCalledTimes(1);
        expect(startW5FlipHandoffMock).toHaveBeenCalledWith({
          admission: { kind },
        });
        const started = startW5FlipHandoffMock.mock.invocationCallOrder[0] ?? 0;
        expect(admitDesktopW5HostMock.mock.invocationCallOrder[0]).toBeLessThan(
          started,
        );
        expect(started).toBeLessThan(
          browserWindowMock.mock.invocationCallOrder[0] ?? 0,
        );
      },
    );

    it('does not start when maintenance refuses the launch', async () => {
      admitDesktopW5HostMock.mockResolvedValueOnce({
        kind: 'refused',
        message: 'Data maintenance is running.',
      });
      const stderrWrite = jest
        .spyOn(process.stderr, 'write')
        .mockImplementation((): boolean => true);
      whenReadyMock.mockResolvedValue(undefined);
      try {
        await import('../index');
        await waitForAppReady();
        expect(startW5FlipHandoffMock).not.toHaveBeenCalled();
      } finally {
        stderrWrite.mockRestore();
      }
    });

    it('releases W5 daemon sessions after the last W5 writer at quit', async () => {
      w5FlipCompiled = true;
      await import('../index');
      const beforeQuit = eventHandlers.get('before-quit');
      if (!beforeQuit) throw new Error('Missing quit hook');
      beforeQuit({ preventDefault: jest.fn() });
      for (let turn = 0; turn < 3; turn += 1) await waitForImmediate();
      expect(disposeW5FlipHandoffMock).toHaveBeenCalledTimes(1);
      // The Ledger slot precedes the W5 commit log slot, which precedes this.
      expect(
        shutdownLedgerStorageHostMock.mock.invocationCallOrder[0] ?? 0,
      ).toBeLessThan(disposeW5FlipHandoffMock.mock.invocationCallOrder[0] ?? 0);
      // A pending handoff ends before the last W5 writers drain, so they
      // refuse at once instead of holding quit for its wait.
      expect(cancelPendingW5FlipHandoffMock).toHaveBeenCalledTimes(1);
      expect(
        cancelPendingW5FlipHandoffMock.mock.invocationCallOrder[0] ?? 0,
      ).toBeLessThan(
        flushWorkspaceTargetTouchesMock.mock.invocationCallOrder[0] ?? 0,
      );
      expect(appQuitMock).toHaveBeenCalledTimes(1);
    });
  });

  it('starts Auto Delete only after the initial renderer window exists', async () => {
    whenReadyMock.mockResolvedValue(undefined);

    await import('../index');
    await waitForAppReady();

    expect(browserWindowMock).toHaveBeenCalled();
    expect(startAutoArchiveSchedulerMock).toHaveBeenCalledTimes(1);
    expect(browserWindowMock.mock.invocationCallOrder[0]).toBeLessThan(
      startAutoArchiveSchedulerMock.mock.invocationCallOrder[0],
    );
  });

  it('replays Auto Delete results after the main renderer acknowledges readiness', async () => {
    whenReadyMock.mockResolvedValue(undefined);
    const createdWindow = createBrowserWindowStub();
    browserWindowMock.mockReturnValue(createdWindow);

    await import('../index');
    await waitForAppReady();

    const publishResult = setAutoArchiveResultListenerMock.mock.calls[0]?.[0];
    expect(publishResult).toEqual(expect.any(Function));
    if (!publishResult) throw new Error('Auto Delete listener not registered');
    publishResult({
      workspaceId: 'workspace-1',
      workspaceName: 'Workspace',
      targetId: 'worktree-1',
      targetName: 'Worktree',
      surface: 'multi-repo',
      inactivityDays: 7,
      status: 'success',
    });

    expect(createdWindow.webContents.send).not.toHaveBeenCalledWith(
      IPC_CHANNELS.autoArchiveCompleted,
      expect.anything(),
    );
    expect(getRegisteredWindowAccessors().isMainWindowRendererReady?.()).toBe(
      false,
    );

    getRegisteredWindowAccessors().notifyStartupUnlocked();
    expect(getRegisteredWindowAccessors().isMainWindowRendererReady?.()).toBe(
      true,
    );

    expect(createdWindow.webContents.send).toHaveBeenCalledWith(
      IPC_CHANNELS.autoArchiveCompleted,
      expect.objectContaining({ targetId: 'worktree-1' }),
    );

    // A sub-frame load leaves the renderer in place.
    createdWindow.webContentsHandlers.get('did-start-loading')?.();
    expect(getRegisteredWindowAccessors().isMainWindowRendererReady?.()).toBe(
      true,
    );
    // A committed main-frame reload replaces it.
    createdWindow.webContentsHandlers.get('did-navigate')?.();
    expect(getRegisteredWindowAccessors().isMainWindowRendererReady?.()).toBe(
      false,
    );
    createdWindow.webContents.send.mockClear();
    publishResult({
      workspaceId: 'workspace-1',
      workspaceName: 'Workspace',
      targetId: 'worktree-2',
      targetName: 'Reloaded worktree',
      surface: 'multi-repo',
      inactivityDays: 7,
      status: 'failure',
    });
    expect(createdWindow.webContents.send).not.toHaveBeenCalled();

    getRegisteredWindowAccessors().notifyStartupUnlocked();
    expect(getRegisteredWindowAccessors().isMainWindowRendererReady?.()).toBe(
      true,
    );

    expect(createdWindow.webContents.send).toHaveBeenCalledWith(
      IPC_CHANNELS.autoArchiveCompleted,
      expect.objectContaining({ targetId: 'worktree-2' }),
    );
  });

  it('moves packaged macOS apps to Applications before starting services', async () => {
    const restorePlatform = setPlatform('darwin');
    whenReadyMock.mockResolvedValue(undefined);
    appIsInApplicationsFolderMock.mockReturnValue(false);
    appMoveToApplicationsFolderMock.mockReturnValue(true);
    showMessageBoxSyncMock.mockReturnValue(0);
    const { app: electronAppMock } = jest.requireMock<{
      app: { isPackaged: boolean };
    }>('electron');
    electronAppMock.isPackaged = true;

    try {
      await import('../index');
      await waitForAppReady();

      expect(showMessageBoxSyncMock).toHaveBeenCalledWith(
        expect.objectContaining({
          message: 'Move Canopy to the Applications folder?',
        }),
      );
      expect(appMoveToApplicationsFolderMock).toHaveBeenCalledTimes(1);
      expect(initializeDesktopInstrumentationMainMock).not.toHaveBeenCalled();
      expect(initializeObservabilityServiceMock).not.toHaveBeenCalled();
      expect(browserWindowMock).not.toHaveBeenCalled();
      expect(startUpdaterMock).not.toHaveBeenCalled();
    } finally {
      electronAppMock.isPackaged = false;
      restorePlatform();
    }
  });

  // The detach is the whole fix for a late in-flight proxy failure pushing
  // records into a torn-down observability service. Without this assertion it
  // is one deleted line away from regressing with no test failing.
  it('detaches the codex gateway proxy diagnostic sink during before-quit cleanup', async () => {
    await import('../index');

    const beforeQuit = eventHandlers.get('before-quit');
    expect(beforeQuit).toBeDefined();
    beforeQuit?.({ preventDefault: jest.fn() });
    await waitForImmediate();

    // `whenReady` never resolves in this block, so the attach does not run;
    // the detach must still happen, and must be the last thing to touch the sink.
    const calls = setCodexGatewayProxyDiagnosticSinkMock.mock.calls;
    expect(calls.length).toBeGreaterThanOrEqual(1);
    expect(calls[calls.length - 1]?.[0]).toBeUndefined();
  });

  it('records LaunchDarkly outages and installs early-retry triggers around the first start (CAN-3511)', async () => {
    whenReadyMock.mockResolvedValue(undefined);
    await import('../index');
    await waitForAppReady();

    expect(setFeatureFlagDiagnosticRecorderMock).toHaveBeenCalledTimes(1);
    expect(
      setFeatureFlagDiagnosticRecorderMock.mock.invocationCallOrder[0],
    ).toBeLessThan(
      initializeFeatureFlagServiceMock.mock.invocationCallOrder[0],
    );
    expect(installFeatureFlagRecoveryTriggersMock).toHaveBeenCalledTimes(1);
    expect(
      installFeatureFlagRecoveryTriggersMock.mock.invocationCallOrder[0],
    ).toBeGreaterThan(
      initializeFeatureFlagServiceMock.mock.invocationCallOrder[0],
    );
    const sources = installFeatureFlagRecoveryTriggersMock.mock.calls[0]?.[1];
    expect(sources?.powerMonitor).toEqual(
      expect.objectContaining({ on: powerMonitorOnMock }),
    );

    const beforeQuit = eventHandlers.get('before-quit');
    beforeQuit?.({ preventDefault: jest.fn() });
    await waitForImmediate();
    await waitForImmediate();

    expect(uninstallFeatureFlagRecoveryTriggersMock).toHaveBeenCalledTimes(1);
    expect(
      uninstallFeatureFlagRecoveryTriggersMock.mock.invocationCallOrder[0],
    ).toBeLessThan(disposeFeatureFlagServiceMock.mock.invocationCallOrder[0]);
  });

  it('seeds Labs before flags, synchronizes after flags, and disposes before flags', async () => {
    whenReadyMock.mockResolvedValue(undefined);
    await import('../index');
    await waitForAppReady();

    expect(getLabsExperimentsServiceMock).toHaveBeenCalledTimes(1);
    expect(initializeLabsExperimentsServiceMock).toHaveBeenCalledTimes(1);
    expect(loadCanopyCloudAccountMock.mock.invocationCallOrder[0]).toBeLessThan(
      getLabsExperimentsServiceMock.mock.invocationCallOrder[0],
    );
    expect(
      getLabsExperimentsServiceMock.mock.invocationCallOrder[0],
    ).toBeLessThan(
      initializeFeatureFlagServiceMock.mock.invocationCallOrder[0],
    );
    expect(
      initializeFeatureFlagServiceMock.mock.invocationCallOrder[0],
    ).toBeLessThan(
      initializeLabsExperimentsServiceMock.mock.invocationCallOrder[0],
    );

    eventHandlers.get('before-quit')?.({ preventDefault: jest.fn() });
    await waitForImmediate();
    await waitForImmediate();

    expect(disposeLabsExperimentsServiceMock).toHaveBeenCalledTimes(1);
    expect(
      disposeLabsExperimentsServiceMock.mock.invocationCallOrder[0],
    ).toBeLessThan(disposeFeatureFlagServiceMock.mock.invocationCallOrder[0]);
  });

  it('stops the shared-container inbox watcher before disposing feature flags', async () => {
    await import('../index');

    const beforeQuit = eventHandlers.get('before-quit');
    expect(beforeQuit).toBeDefined();
    beforeQuit?.({ preventDefault: jest.fn() });
    await waitForImmediate();
    await waitForImmediate();

    expect(foreignActivityCarryoverServiceMock.shutdown).toHaveBeenCalledTimes(
      1,
    );
    expect(shutdownSharedContainerInboxWatcherMock).toHaveBeenCalledTimes(1);
    expect(disposeFeatureFlagServiceMock).toHaveBeenCalledTimes(1);
    expect(
      shutdownSharedContainerInboxWatcherMock.mock.invocationCallOrder[0],
    ).toBeLessThan(disposeFeatureFlagServiceMock.mock.invocationCallOrder[0]);
  });

  it('reports a rejected foreign-activity shutdown as failed and keeps cleaning up', async () => {
    foreignActivityCarryoverServiceMock.shutdown.mockRejectedValueOnce(
      new Error('carryover persist failed'),
    );
    await import('../index');

    const beforeQuit = eventHandlers.get('before-quit');
    expect(beforeQuit).toBeDefined();
    beforeQuit?.({ preventDefault: jest.fn() });
    await waitForImmediate();
    await waitForImmediate();

    expect(recordAppDiagnosticMock).toHaveBeenCalledWith(
      expect.objectContaining({
        kind: 'runtime_cleanup_stage',
        cleanupStage: 'foreign-activity',
        cleanupStatus: 'failed',
      }),
    );
    expect(recordAppDiagnosticMock).not.toHaveBeenCalledWith(
      expect.objectContaining({
        cleanupStage: 'foreign-activity',
        cleanupStatus: 'completed',
      }),
    );
    expect(shutdownSharedContainerInboxWatcherMock).toHaveBeenCalledTimes(1);
  });

  it('stops running shell scripts during before-quit cleanup', async () => {
    whenReadyMock.mockResolvedValue(undefined);
    getAllActiveSessionInfosMock.mockReturnValue([
      {
        projectId: 'active-project',
        worktreeId: 'active-worktree',
        turnActive: true,
        pendingMessageCount: 0,
      },
    ]);
    await import('../index');
    await waitForAppReady();

    const beforeQuit = eventHandlers.get('before-quit');
    expect(beforeQuit).toBeDefined();

    const preventDefault = jest.fn();
    beforeQuit?.({ preventDefault });
    await waitForImmediate();

    expect(preventDefault).toHaveBeenCalledTimes(1);
    expect(stopAllOutputPollingMock).toHaveBeenCalledTimes(1);
    expect(stopAutoArchiveMock).toHaveBeenCalledTimes(1);
    expect(stopAutoArchiveMock.mock.invocationCallOrder[0]).toBeLessThan(
      destroyAllSessionsMock.mock.invocationCallOrder[0],
    );
    expect(pauseAllActivePipelineExecutionsMock).toHaveBeenCalledTimes(1);
    expect(shutdownBackgroundHelperQueueMock).toHaveBeenCalledTimes(1);
    await waitForImmediate();
    expect(shutdownDelegationLifecycleMock).toHaveBeenCalledTimes(1);
    expect(destroyAllSessionsMock).toHaveBeenCalledTimes(1);
    expect(touchWorkspaceTargetMock).toHaveBeenCalledWith(
      'active-project',
      'active-worktree',
      expect.any(Number),
    );
    expect(touchWorkspaceTargetMock.mock.invocationCallOrder[0]).toBeLessThan(
      destroyAllSessionsMock.mock.invocationCallOrder[0],
    );
    expect(
      shutdownDelegationLifecycleMock.mock.invocationCallOrder[0],
    ).toBeLessThan(destroyAllSessionsMock.mock.invocationCallOrder[0]);
    expect(
      shutdownBackgroundHelperQueueMock.mock.invocationCallOrder[0],
    ).toBeLessThan(destroyAllSessionsMock.mock.invocationCallOrder[0]);
    expect(destroyAllSessionsMock.mock.invocationCallOrder[0]).toBeLessThan(
      stopAllOutputPollingMock.mock.invocationCallOrder[0],
    );
    await waitForImmediate();
    expect(cancelAllDiscoveriesMock).toHaveBeenCalledTimes(1);
    expect(stopAllRunningHooksMock).toHaveBeenCalledTimes(1);
    expect(stopAllRunningShellScriptsMock).toHaveBeenCalledTimes(1);
    expect(cancelStartupBackgroundTasksMock).not.toHaveBeenCalled();
    expect(stopWorktreeBranchWatchersMock).toHaveBeenCalledTimes(1);
    expect(shutdownClaudeTerminalServiceMock).toHaveBeenCalledTimes(1);
    expect(
      shutdownClaudeTerminalServiceMock.mock.invocationCallOrder[0],
    ).toBeLessThan(killAllTerminalsMock.mock.invocationCallOrder[0]);
    expect(markAllLiveTerminalsExitedMock).toHaveBeenCalledWith('app-quit');
    expect(killAllTerminalsMock).toHaveBeenCalledTimes(1);
    await waitForImmediate();
    expect(shutdownAuthTerminalManagerMock).toHaveBeenCalledTimes(1);
    expect(flushWorkspaceTargetTouchesMock).toHaveBeenCalledTimes(1);
    expect(disposeAutoArchiveActivitySubscriptionsMock).toHaveBeenCalledTimes(
      1,
    );
    expect(killAllTerminalsMock.mock.invocationCallOrder[0]).toBeLessThan(
      flushWorkspaceTargetTouchesMock.mock.invocationCallOrder[0],
    );
    expect(
      flushWorkspaceTargetTouchesMock.mock.invocationCallOrder[0],
    ).toBeLessThan(
      disposeAutoArchiveActivitySubscriptionsMock.mock.invocationCallOrder[0],
    );
    expect(shutdownPipelineProcessHostMock).toHaveBeenCalledTimes(1);
    expect(shutdownClaudeProcessHostMock).toHaveBeenCalledTimes(1);
    expect(cleanupGatewayCompatibleCodexCatalogMock).toHaveBeenCalledTimes(1);
    expect(shutdownCodeGraphBaseManagerMock).toHaveBeenCalledTimes(1);
    expect(killAllBuildsMock).toHaveBeenCalledTimes(1);
    expect(shutdownCodeGraphReadWorkersMock).toHaveBeenCalledTimes(1);
    expect(
      shutdownCodeGraphBaseManagerMock.mock.invocationCallOrder[0],
    ).toBeLessThan(killAllBuildsMock.mock.invocationCallOrder[0]);
    expect(shutdownWakeLockServiceMock).toHaveBeenCalledTimes(1);
    expect(shutdownVoiceServiceMock).toHaveBeenCalledTimes(1);
    expect(shutdownOllamaServiceMock).toHaveBeenCalledWith('app-quit');
    // The integration server shutdown is awaited before stopUpdater runs, so
    // yield once to let the microtask resolve before checking subsequent
    // synchronous calls in the cleanup chain.
    await waitForImmediate();
    // The desktop integration server is an alias of the MCP proxy, so it is
    // shut down and reported once, under the proxy's stage.
    expect(shutdownMcpHttpProxyMock).toHaveBeenCalledTimes(1);
    expect(shutdownDesktopIntegrationServerMock).not.toHaveBeenCalled();
    expect(recordAppDiagnosticMock).toHaveBeenCalledWith(
      expect.objectContaining({
        kind: 'runtime_cleanup_stage',
        cleanupStage: 'mcp-proxy',
        cleanupStatus: 'completed',
      }),
    );
    expect(recordAppDiagnosticMock).not.toHaveBeenCalledWith(
      expect.objectContaining({ cleanupStage: 'desktop-integration' }),
    );
    expect(stopUpdaterMock).toHaveBeenCalledTimes(1);
    expect(recordAppDiagnosticMock).toHaveBeenCalledWith(
      expect.objectContaining({ kind: 'before_quit' }),
    );
    await waitForImmediate();
    expect(flushPreferencesWritesMock).toHaveBeenCalledTimes(1);
    expect(appQuitMock).toHaveBeenCalledTimes(1);
  });

  it('stops Ledger storage right after the lifecycle reports idle', async () => {
    await import('../index');

    const beforeQuit = eventHandlers.get('before-quit');
    if (!beforeQuit) throw new Error('Missing quit hook');
    beforeQuit({ preventDefault: jest.fn() });
    for (let turn = 0; turn < 3; turn += 1) await waitForImmediate();

    // With nothing queued (or no lifecycle at all) the wait costs no timer.
    expect(whenLedgerLifecycleIdleMock).toHaveBeenCalledTimes(1);
    expect(shutdownLedgerStorageHostMock).toHaveBeenCalledTimes(1);
    expect(
      whenLedgerLifecycleIdleMock.mock.invocationCallOrder[0],
    ).toBeLessThan(
      shutdownLedgerStorageHostMock.mock.invocationCallOrder[0] ??
        Number.POSITIVE_INFINITY,
    );
    expect(appQuitMock).toHaveBeenCalledTimes(1);
  });

  it('waits for queued Ledger lifecycle steps before stopping Ledger storage', async () => {
    let lifecycleIdle: (() => void) | undefined;
    whenLedgerLifecycleIdleMock.mockReturnValueOnce(
      new Promise<void>((resolve) => {
        lifecycleIdle = resolve;
      }),
    );
    await import('../index');

    const beforeQuit = eventHandlers.get('before-quit');
    if (!beforeQuit) throw new Error('Missing quit hook');
    beforeQuit({ preventDefault: jest.fn() });
    for (let turn = 0; turn < 3; turn += 1) await waitForImmediate();

    expect(whenLedgerLifecycleIdleMock).toHaveBeenCalledTimes(1);
    expect(shutdownLedgerStorageHostMock).not.toHaveBeenCalled();
    expect(appQuitMock).not.toHaveBeenCalled();

    if (!lifecycleIdle) throw new Error('Expected a pending lifecycle drain');
    lifecycleIdle();
    for (let turn = 0; turn < 3; turn += 1) await waitForImmediate();

    expect(shutdownLedgerStorageHostMock).toHaveBeenCalledTimes(1);
    expect(appQuitMock).toHaveBeenCalledTimes(1);
  });

  it('stops Ledger storage after a bounded wait when lifecycle steps never settle', async () => {
    jest.useFakeTimers({
      doNotFake: ['setImmediate', 'nextTick', 'queueMicrotask'],
    });
    try {
      whenLedgerLifecycleIdleMock.mockReturnValueOnce(
        new Promise<void>(() => undefined),
      );
      await import('../index');

      const beforeQuit = eventHandlers.get('before-quit');
      if (!beforeQuit) throw new Error('Missing quit hook');
      beforeQuit({ preventDefault: jest.fn() });
      for (let turn = 0; turn < 3; turn += 1) await waitForImmediate();

      expect(whenLedgerLifecycleIdleMock).toHaveBeenCalledTimes(1);
      jest.advanceTimersByTime(1_999);
      await waitForImmediate();
      expect(shutdownLedgerStorageHostMock).not.toHaveBeenCalled();

      jest.advanceTimersByTime(1);
      for (let turn = 0; turn < 3; turn += 1) await waitForImmediate();

      expect(shutdownLedgerStorageHostMock).toHaveBeenCalledTimes(1);
      expect(appQuitMock).toHaveBeenCalledTimes(1);
    } finally {
      jest.useRealTimers();
    }
  });

  it('keeps providers alive and rejects repeated quits until chat and pipeline checkpoints drain', async () => {
    let finishChats!: () => void;
    let finishPipelines!: () => void;
    destroyAllSessionsMock.mockReturnValueOnce(
      new Promise<void>((resolve) => {
        finishChats = resolve;
      }),
    );
    pauseAllActivePipelineExecutionsMock.mockReturnValueOnce(
      new Promise<void>((resolve) => {
        finishPipelines = resolve;
      }),
    );
    await import('../index');
    const beforeQuit = eventHandlers.get('before-quit');
    if (!beforeQuit) throw new Error('Missing quit hook');
    const preventDefault = jest.fn();
    beforeQuit({ preventDefault });
    beforeQuit({ preventDefault });
    await waitForImmediate();
    expect(preventDefault).toHaveBeenCalledTimes(2);
    expect(shutdownPipelineProcessHostMock).not.toHaveBeenCalled();
    expect(shutdownClaudeProcessHostMock).not.toHaveBeenCalled();
    expect(appQuitMock).not.toHaveBeenCalled();
    finishChats();
    await waitForImmediate();
    expect(appQuitMock).not.toHaveBeenCalled();
    finishPipelines();
    await waitForImmediate();
    expect(appQuitMock).toHaveBeenCalledTimes(1);
  });

  it('keeps Copilot runtimes until chat and pipeline checkpoints drain', async () => {
    let finishChats!: () => void;
    let finishPipelines!: () => void;
    destroyAllSessionsMock.mockReturnValueOnce(
      new Promise<void>((resolve) => {
        finishChats = resolve;
      }),
    );
    pauseAllActivePipelineExecutionsMock.mockReturnValueOnce(
      new Promise<void>((resolve) => {
        finishPipelines = resolve;
      }),
    );
    await import('../index');
    const beforeQuit = eventHandlers.get('before-quit');
    if (!beforeQuit) throw new Error('Missing quit hook');
    beforeQuit({ preventDefault: jest.fn() });
    for (let turn = 0; turn < 3; turn += 1) await waitForImmediate();
    // An active Copilot turn must still be live when chats record interruption.
    expect(destroyAllSessionsMock).toHaveBeenCalledWith({
      recordInterrupted: true,
    });
    expect(pauseAllActivePipelineExecutionsMock).toHaveBeenCalledTimes(1);
    expect(mockCopilotRuntimesShutdown).not.toHaveBeenCalled();
    finishChats();
    for (let turn = 0; turn < 3; turn += 1) await waitForImmediate();
    expect(mockCopilotRuntimesShutdown).not.toHaveBeenCalled();
    finishPipelines();
    for (let turn = 0; turn < 3; turn += 1) await waitForImmediate();
    expect(mockCopilotRuntimesShutdown).toHaveBeenCalledTimes(1);
    expect(appQuitMock).toHaveBeenCalledTimes(1);
  });

  it('finishes recovery drains and child teardown before exiting after a shutdown failure', async () => {
    let finishChatShutdown: (() => void) | undefined;
    pauseAllActivePipelineExecutionsMock.mockRejectedValueOnce(
      new Error('checkpoint failed'),
    );
    destroyAllSessionsMock.mockReturnValueOnce(
      new Promise<void>((resolve) => {
        finishChatShutdown = resolve;
      }),
    );
    const consoleError = jest
      .spyOn(console, 'error')
      .mockImplementation(() => undefined);
    try {
      await import('../index');
      const beforeQuit = eventHandlers.get('before-quit');
      expect(beforeQuit).toBeDefined();

      beforeQuit?.({ preventDefault: jest.fn() });
      await waitForImmediate();
      await waitForImmediate();

      expect(appExitMock).not.toHaveBeenCalled();
      expect(shutdownPipelineProcessHostMock).not.toHaveBeenCalled();

      finishChatShutdown?.();
      await waitForImmediate();
      await waitForImmediate();

      expect(shutdownPipelineProcessHostMock).toHaveBeenCalledTimes(1);
      expect(shutdownClaudeProcessHostMock).toHaveBeenCalledTimes(1);
      expect(appExitMock).toHaveBeenCalledWith(0);
    } finally {
      finishChatShutdown?.();
      consoleError.mockRestore();
    }
  });

  it.each([
    [
      'resume-queue',
      (error: Error): void => {
        mockFlushResumeQueue.mockRejectedValueOnce(error);
      },
    ],
    [
      'ledger-pending-titles',
      (error: Error): void => {
        mockShutdownPendingTitles.mockRejectedValueOnce(error);
      },
    ],
    [
      'auto-archive',
      (error: Error): void => {
        stopAutoArchiveMock.mockRejectedValueOnce(error);
      },
    ],
  ])(
    'still drains recovery and stops Copilot when the %s preparatory stage fails',
    async (stage, failStage) => {
      whenReadyMock.mockResolvedValue(undefined);
      const failure = new Error(`${stage} failed`);
      failStage(failure);
      const shutdown = captureShutdownOutcome();
      const consoleError = jest
        .spyOn(console, 'error')
        .mockImplementation(() => undefined);
      try {
        await import('../index');
        await waitForAppReady();
        const { logMainProcessWarn } =
          await import('../lib/main-process-logging');
        const beforeQuit = eventHandlers.get('before-quit');
        if (!beforeQuit) throw new Error('Missing quit hook');
        beforeQuit({ preventDefault: jest.fn() });

        // Quit still fails, with the stage's own error, after teardown.
        expect(await shutdown.outcome).toBe('exit');
        expect(appExitMock).toHaveBeenCalledWith(0);
        expect(appQuitMock).not.toHaveBeenCalled();
        expect(consoleError).toHaveBeenCalledWith(
          'Application shutdown could not save interrupted work:',
          failure,
        );
        expect(recordAppDiagnosticMock).toHaveBeenCalledWith(
          expect.objectContaining({
            cleanupStage: stage,
            cleanupStatus: 'failed',
          }),
        );
        // The remaining preparation, both drains and Copilot's stop all ran.
        expect(mockShutdownPendingTitles).toHaveBeenCalledTimes(1);
        expect(stopAutoArchiveMock).toHaveBeenCalledTimes(1);
        expect(pauseAllActivePipelineExecutionsMock).toHaveBeenCalledTimes(1);
        expect(destroyAllSessionsMock).toHaveBeenCalledWith({
          recordInterrupted: true,
        });
        expect(mockCopilotRuntimesShutdown).toHaveBeenCalledTimes(1);
        const [copilotStop = -1] =
          mockCopilotRuntimesShutdown.mock.invocationCallOrder;
        expect(
          pauseAllActivePipelineExecutionsMock.mock.invocationCallOrder[0],
        ).toBeLessThan(copilotStop);
        expect(destroyAllSessionsMock.mock.invocationCallOrder[0]).toBeLessThan(
          copilotStop,
        );
        expect(recordAppDiagnosticMock).toHaveBeenCalledWith(
          expect.objectContaining({
            cleanupStage: 'cursor-connections',
            cleanupStatus: 'completed',
          }),
        );
        expect(shutdownPipelineProcessHostMock).toHaveBeenCalledTimes(1);
        expect(logMainProcessWarn).toHaveBeenCalledWith(
          '[shutdown] Preparatory stage failed',
          failure,
        );
      } finally {
        consoleError.mockRestore();
        shutdown.restore();
      }
    },
  );

  it('reports both a preparatory failure and a recovery-drain failure', async () => {
    const preparation = new Error('resume queue flush failed');
    mockFlushResumeQueue.mockRejectedValueOnce(preparation);
    pauseAllActivePipelineExecutionsMock.mockRejectedValueOnce(
      new Error('checkpoint failed'),
    );
    const shutdown = captureShutdownOutcome();
    const consoleError = jest
      .spyOn(console, 'error')
      .mockImplementation(() => undefined);
    try {
      await import('../index');
      const { logMainProcessWarn } =
        await import('../lib/main-process-logging');
      const beforeQuit = eventHandlers.get('before-quit');
      if (!beforeQuit) throw new Error('Missing quit hook');
      beforeQuit({ preventDefault: jest.fn() });

      expect(await shutdown.outcome).toBe('exit');
      // The recovery-drain failure stays the quit error; preparation is logged.
      const quitLog = consoleError.mock.calls.find(
        ([message]) =>
          message === 'Application shutdown could not save interrupted work:',
      );
      const quitError: unknown = quitLog?.[1];
      expect(quitError).toBeInstanceOf(Error);
      expect(quitError instanceof Error ? quitError.message : '').toContain(
        'Application shutdown recovery drain failed: Error: checkpoint failed',
      );
      expect(logMainProcessWarn).toHaveBeenCalledWith(
        '[shutdown] Preparatory stage failed',
        preparation,
      );
      for (const cleanupStage of ['resume-queue', 'pipeline-recovery']) {
        expect(recordAppDiagnosticMock).toHaveBeenCalledWith(
          expect.objectContaining({ cleanupStage, cleanupStatus: 'failed' }),
        );
      }
      expect(mockCopilotRuntimesShutdown).toHaveBeenCalledTimes(1);
      expect(shutdownPipelineProcessHostMock).toHaveBeenCalledTimes(1);
      expect(appQuitMock).not.toHaveBeenCalled();
    } finally {
      consoleError.mockRestore();
      shutdown.restore();
    }
  });

  it('does not block critical teardown on the bounded runtime drain', async () => {
    whenReadyMock.mockResolvedValue(undefined);
    let resolveRuntimeShutdown: (() => void) | undefined;
    shutdownDesktopCanopyRuntimeMock.mockImplementation(
      () =>
        new Promise<void>((resolve) => {
          resolveRuntimeShutdown = resolve;
        }),
    );
    await import('../index');
    await waitForAppReady();

    const runtimeOptions = createDesktopRuntimeMock.mock.calls[0]?.[0];
    expect(runtimeOptions?.shutdownTimeoutMs).toBe(750);
    expect(typeof runtimeOptions?.getChatStatePort).toBe('function');
    const beforeQuit = eventHandlers.get('before-quit');
    beforeQuit?.({ preventDefault: jest.fn() });
    await waitForImmediate();

    expect(shutdownDesktopCanopyRuntimeMock).toHaveBeenCalledTimes(1);
    expect(markAllLiveTerminalsExitedMock).toHaveBeenCalledWith('app-quit');
    expect(killAllTerminalsMock).toHaveBeenCalledTimes(1);
    expect(appQuitMock).not.toHaveBeenCalled();

    if (!resolveRuntimeShutdown) {
      throw new Error('Expected desktop runtime shutdown to be pending');
    }
    resolveRuntimeShutdown();
    await waitForImmediate();
  });

  it('delays Electron quit until preference writes are flushed', async () => {
    let resolvePreferenceFlush: (() => void) | undefined;
    flushPreferencesWritesMock.mockImplementation(
      () =>
        new Promise<void>((resolve) => {
          resolvePreferenceFlush = resolve;
        }),
    );
    await import('../index');

    const beforeQuit = eventHandlers.get('before-quit');
    expect(beforeQuit).toBeDefined();

    beforeQuit?.({ preventDefault: jest.fn() });
    // Allow the awaited proxy-shutdown microtask to settle before checking
    // synchronous post-await side effects.
    await waitForImmediate();
    await Promise.resolve();

    expect(flushPreferencesWritesMock).toHaveBeenCalledTimes(1);
    expect(appQuitMock).not.toHaveBeenCalled();

    if (!resolvePreferenceFlush) {
      throw new Error('Expected preference flush promise to be pending');
    }

    resolvePreferenceFlush();
    await waitForImmediate();

    expect(appQuitMock).toHaveBeenCalledTimes(1);
  });

  it('delays Electron quit until the main-process log drain completes', async () => {
    let resolveLogDrain: (() => void) | undefined;
    drainMainProcessLoggingMock.mockImplementationOnce(
      () =>
        new Promise<void>((resolve) => {
          resolveLogDrain = resolve;
        }),
    );
    await import('../index');

    const beforeQuit = eventHandlers.get('before-quit');
    expect(beforeQuit).toBeDefined();

    beforeQuit?.({ preventDefault: jest.fn() });
    await waitForImmediate();
    await waitForImmediate();

    // Runtime cleanup has finished; only the final log drain is outstanding.
    expect(flushPreferencesWritesMock).toHaveBeenCalledTimes(1);
    expect(drainMainProcessLoggingMock).toHaveBeenCalledTimes(1);
    expect(appQuitMock).not.toHaveBeenCalled();

    if (!resolveLogDrain) {
      throw new Error('Expected the log drain promise to be pending');
    }

    resolveLogDrain();
    await waitForImmediate();

    expect(appQuitMock).toHaveBeenCalledTimes(1);
    expect(drainMainProcessLoggingBestEffortMock).not.toHaveBeenCalled();
  });

  it('delays Electron quit until active pipelines finish cancellation', async () => {
    let resolvePipelineCancellation: (() => void) | undefined;
    pauseAllActivePipelineExecutionsMock.mockImplementation(
      () =>
        new Promise<void>((resolve) => {
          resolvePipelineCancellation = resolve;
        }),
    );

    await import('../index');

    const beforeQuit = eventHandlers.get('before-quit');
    expect(beforeQuit).toBeDefined();

    beforeQuit?.({ preventDefault: jest.fn() });
    await waitForImmediate();

    expect(pauseAllActivePipelineExecutionsMock).toHaveBeenCalledTimes(1);
    expect(shutdownPipelineProcessHostMock).not.toHaveBeenCalled();
    expect(shutdownMcpHttpProxyMock).not.toHaveBeenCalled();
    expect(appQuitMock).not.toHaveBeenCalled();

    if (!resolvePipelineCancellation) {
      throw new Error('Expected pipeline cancellation promise to be pending');
    }

    resolvePipelineCancellation();
    await waitForImmediate();
    await waitForImmediate();

    expect(shutdownPipelineProcessHostMock).toHaveBeenCalledTimes(1);
    expect(shutdownMcpHttpProxyMock).toHaveBeenCalledTimes(1);
    expect(appQuitMock).toHaveBeenCalledTimes(1);
  });

  it('delays Electron quit until active project splits drain', async () => {
    let resolveSplitDrain: (() => void) | undefined;
    drainSplitTemporaryWorkspaceBackgroundPhasesMock.mockImplementation(
      () =>
        new Promise<void>((resolve) => {
          resolveSplitDrain = resolve;
        }),
    );

    await import('../index');

    const beforeQuit = eventHandlers.get('before-quit');
    expect(beforeQuit).toBeDefined();

    beforeQuit?.({ preventDefault: jest.fn() });
    await waitForImmediate();

    expect(
      drainSplitTemporaryWorkspaceBackgroundPhasesMock,
    ).toHaveBeenCalledTimes(1);
    expect(beginSplitTemporaryWorkspaceShutdownMock).toHaveBeenCalledTimes(1);
    expect(
      beginSplitTemporaryWorkspaceShutdownMock.mock.invocationCallOrder[0],
    ).toBeLessThan(
      drainSplitTemporaryWorkspaceBackgroundPhasesMock.mock
        .invocationCallOrder[0] ?? Number.POSITIVE_INFINITY,
    );
    expect(appQuitMock).not.toHaveBeenCalled();

    if (!resolveSplitDrain) {
      throw new Error('Expected split background drain promise to be pending');
    }

    resolveSplitDrain();
    await waitForImmediate();
    await waitForImmediate();

    expect(appQuitMock).toHaveBeenCalledTimes(1);
  });

  it('passes cleanup callback to updater restart installs', async () => {
    whenReadyMock.mockResolvedValue(undefined);
    let resolvePreferenceFlush: (() => void) | undefined;
    flushPreferencesWritesMock.mockImplementation(
      () =>
        new Promise<void>((resolve) => {
          resolvePreferenceFlush = resolve;
        }),
    );

    await import('../index');
    await waitForAppReady();

    getRegisteredWindowAccessors().notifyStartupUnlocked();

    const beforeInstall = startUpdaterMock.mock.calls[0]?.[1];
    if (typeof beforeInstall !== 'function') {
      throw new Error('Expected updater cleanup callback to be registered');
    }

    const cleanupPromise = beforeInstall();
    await waitForImmediate();
    await Promise.resolve();

    expect(stopAllOutputPollingMock).toHaveBeenCalledTimes(1);
    expect(pauseAllActivePipelineExecutionsMock).toHaveBeenCalledTimes(1);
    expect(flushPreferencesWritesMock).toHaveBeenCalledTimes(1);
    expect(appQuitMock).not.toHaveBeenCalled();

    if (!resolvePreferenceFlush) {
      throw new Error('Expected preference flush promise to be pending');
    }

    resolvePreferenceFlush();
    await cleanupPromise;

    expect(disposeObservabilityServiceMock).toHaveBeenCalledTimes(1);
    expect(appQuitMock).not.toHaveBeenCalled();
  });

  it('forces exit after updater cleanup cannot save interrupted work', async () => {
    whenReadyMock.mockResolvedValue(undefined);
    pauseAllActivePipelineExecutionsMock.mockRejectedValueOnce(
      new Error('checkpoint failed'),
    );
    const consoleError = jest
      .spyOn(console, 'error')
      .mockImplementation(() => undefined);

    try {
      await import('../index');
      await waitForAppReady();
      getRegisteredWindowAccessors().notifyStartupUnlocked();

      const beforeInstall = startUpdaterMock.mock.calls[0]?.[1];
      if (typeof beforeInstall !== 'function') {
        throw new Error('Expected updater cleanup callback to be registered');
      }

      await expect(beforeInstall()).resolves.toBeUndefined();
      expect(appExitMock).toHaveBeenCalledWith(0);
    } finally {
      consoleError.mockRestore();
    }
  });

  it('repairs interrupted work before opening the first window', async () => {
    const { recoverInterruptedWorkAtStartup } =
      await import('../lib/interrupted-work-recovery');
    let releaseRecovery!: () => void;
    jest.mocked(recoverInterruptedWorkAtStartup).mockImplementationOnce(
      () =>
        new Promise<void>((resolve) => {
          releaseRecovery = resolve;
        }),
    );
    whenReadyMock.mockResolvedValue(undefined);
    await import('../index');
    for (let attempt = 0; attempt < 100 && !releaseRecovery; attempt += 1)
      await waitForImmediate();
    expect(recoverInterruptedWorkAtStartup).toHaveBeenCalledTimes(1);
    expect(browserWindowMock).not.toHaveBeenCalled();
    releaseRecovery();
    await waitForAppReady();
    expect(browserWindowMock).toHaveBeenCalledTimes(1);
  });

  it('reaps prior Copilot processes before repairing work or opening a window', async () => {
    const { recoverInterruptedWorkAtStartup } =
      await import('../lib/interrupted-work-recovery');
    let releaseCopilot: (() => void) | undefined;
    mockRecoverCopilotAtStartup.mockImplementationOnce(
      () =>
        new Promise<void>((resolve) => {
          releaseCopilot = resolve;
        }),
    );
    whenReadyMock.mockResolvedValue(undefined);
    await import('../index');
    try {
      for (let attempt = 0; attempt < 100 && !releaseCopilot; attempt += 1)
        await waitForImmediate();
      expect(mockRecoverCopilotAtStartup).toHaveBeenCalledTimes(1);
      expect(recoverInterruptedWorkAtStartup).not.toHaveBeenCalled();
      expect(browserWindowMock).not.toHaveBeenCalled();
    } finally {
      // Drain the deferred startup before the next test resets modules.
      releaseCopilot?.();
      await waitForAppReady();
    }
    expect(recoverInterruptedWorkAtStartup).toHaveBeenCalledTimes(1);
    expect(browserWindowMock).toHaveBeenCalledTimes(1);
  });

  it('warns and continues startup when Copilot process recovery fails', async () => {
    const { recoverInterruptedWorkAtStartup } =
      await import('../lib/interrupted-work-recovery');
    const { logMainProcessWarn } = await import('../lib/main-process-logging');
    const failure = new Error('Copilot process recovery did not finish.');
    mockRecoverCopilotAtStartup.mockRejectedValueOnce(failure);
    whenReadyMock.mockResolvedValue(undefined);
    await import('../index');
    await waitForAppReady();
    expect(mockRecoverCopilotAtStartup).toHaveBeenCalledTimes(1);
    expect(logMainProcessWarn).toHaveBeenCalledWith(
      '[copilot] Startup process recovery did not finish',
      failure,
    );
    expect(recoverInterruptedWorkAtStartup).toHaveBeenCalledTimes(1);
    expect(browserWindowMock).toHaveBeenCalledTimes(1);
  });

  it('skips interrupted-work recovery when a quit begins during the Copilot reaper', async () => {
    const { recoverInterruptedWorkAtStartup } =
      await import('../lib/interrupted-work-recovery');
    const shutdown = createQuitTestScope();
    let releaseCopilot: (() => void) | undefined;
    mockRecoverCopilotAtStartup.mockImplementationOnce(
      () =>
        new Promise<void>((resolve) => {
          releaseCopilot = resolve;
        }),
    );
    whenReadyMock.mockResolvedValue(undefined);
    try {
      await import('../index');
      for (let attempt = 0; attempt < 100 && !releaseCopilot; attempt += 1)
        await waitForImmediate();
      const beforeQuit = eventHandlers.get('before-quit');
      if (!releaseCopilot || !beforeQuit)
        throw new Error('Expected startup to wait on the Copilot reaper');
      shutdown.commit(() => beforeQuit({ preventDefault: jest.fn() }));
      await shutdown.drain();
      releaseCopilot();
      for (let turn = 0; turn < 3; turn += 1) await waitForImmediate();
      await waitForAppReady();
      expect(recoverInterruptedWorkAtStartup).not.toHaveBeenCalled();
      expect(browserWindowMock).not.toHaveBeenCalled();
    } finally {
      releaseCopilot?.();
      shutdown.restore();
    }
  });

  it('does not reap Copilot processes once a quit began during startup', async () => {
    const shutdown = createQuitTestScope();
    let releaseMigration: (() => void) | undefined;
    migrateOpenAppLinksInBuiltInBrowserDefaultMock.mockImplementationOnce(
      () =>
        new Promise<void>((resolve) => {
          releaseMigration = resolve;
        }),
    );
    whenReadyMock.mockResolvedValue(undefined);
    try {
      await import('../index');
      for (let attempt = 0; attempt < 100 && !releaseMigration; attempt += 1)
        await waitForImmediate();
      const beforeQuit = eventHandlers.get('before-quit');
      if (!releaseMigration || !beforeQuit)
        throw new Error('Expected startup to wait on the last migration');
      shutdown.commit(() => beforeQuit({ preventDefault: jest.fn() }));
      releaseMigration();
      await shutdown.drain();
      await waitForAppReady();
      expect(mockRecoverCopilotAtStartup).not.toHaveBeenCalled();
      expect(startPreferencesGenerationStampMock).not.toHaveBeenCalled();
      expect(browserWindowMock).not.toHaveBeenCalled();
    } finally {
      releaseMigration?.();
      shutdown.restore();
    }
  });

  it('starts the preferences generation stamp after the startup migrations', async () => {
    whenReadyMock.mockResolvedValue(undefined);

    await import('../index');
    await waitForAppReady();

    expect(startPreferencesGenerationStampMock).toHaveBeenCalledTimes(1);
    // No test wait: production uses its own background timer.
    expect(startPreferencesGenerationStampMock).toHaveBeenCalledWith();
    expect(
      migrateOpenAppLinksInBuiltInBrowserDefaultMock.mock
        .invocationCallOrder[0],
    ).toBeLessThan(
      startPreferencesGenerationStampMock.mock.invocationCallOrder[0] ?? 0,
    );
    expect(stopPreferencesGenerationStampMock).not.toHaveBeenCalled();
  });

  it('stops the preferences generation stamp before the quit flush', async () => {
    await import('../index');

    const beforeQuit = eventHandlers.get('before-quit');
    if (!beforeQuit) throw new Error('Missing quit hook');
    beforeQuit({ preventDefault: jest.fn() });
    for (let turn = 0; turn < 3; turn += 1) await waitForImmediate();

    expect(stopPreferencesGenerationStampMock).toHaveBeenCalledTimes(1);
    expect(flushPreferencesWritesMock).toHaveBeenCalledTimes(1);
    expect(
      stopPreferencesGenerationStampMock.mock.invocationCallOrder[0],
    ).toBeLessThan(
      flushPreferencesWritesMock.mock.invocationCallOrder[0] ??
        Number.POSITIVE_INFINITY,
    );
    expect(appQuitMock).toHaveBeenCalledTimes(1);
  });

  it('waits for the rollout snapshot before starting provider usage reads', async () => {
    let releaseFlags: (() => void) | undefined;
    initializeFeatureFlagServiceMock.mockImplementationOnce(
      () =>
        new Promise<void>((resolve) => {
          releaseFlags = resolve;
        }),
    );
    whenReadyMock.mockResolvedValue(undefined);
    await import('../index');
    for (let attempt = 0; attempt < 100 && !releaseFlags; attempt += 1)
      await waitForImmediate();
    expect(initializeFeatureFlagServiceMock).toHaveBeenCalledTimes(1);
    if (!releaseFlags) {
      throw new Error('Expected feature flag initialization to be pending');
    }
    try {
      expect(initializeObservabilityServiceMock).not.toHaveBeenCalled();
    } finally {
      releaseFlags();
      await waitForAppReady();
    }
    expect(initializeObservabilityServiceMock).toHaveBeenCalledTimes(1);
  });

  it('reports missing bundled binaries after the login-shell PATH prewarm', async () => {
    whenReadyMock.mockResolvedValue(undefined);

    await import('../index');
    await waitForAppReady();

    expect(prewarmLoginShellPathMock).toHaveBeenCalledTimes(1);
    expect(scheduleMissingBundledBinaryReportMock).toHaveBeenCalledTimes(1);
    expect(scheduleMissingBundledBinaryReportMock).toHaveBeenCalledWith(
      prewarmLoginShellPathMock.mock.results[0]?.value,
    );
  });

  it('creates the window without waiting for observability startup to finish', async () => {
    whenReadyMock.mockResolvedValue(undefined);
    initializeObservabilityServiceMock.mockImplementation(
      () => new Promise<void>(() => {}),
    );

    await import('../index');
    await waitForAppReady();

    expect(initializeObservabilityServiceMock).toHaveBeenCalledTimes(1);
    expect(browserWindowMock).toHaveBeenCalledTimes(1);
  });

  it('wires Codex gateway proxy diagnostics into observability', async () => {
    whenReadyMock.mockResolvedValue(undefined);

    await import('../index');
    await waitForAppReady();

    expect(setCodexGatewayProxyDiagnosticSinkMock).toHaveBeenCalledTimes(1);
    const sink = setCodexGatewayProxyDiagnosticSinkMock.mock.calls[0]?.[0];
    if (!sink) throw new Error('Expected Codex gateway diagnostic sink');
    const record = { kind: 'codex_gateway_proxy_retry' };
    sink(record);
    expect(recordSessionDiagnosticMock).toHaveBeenCalledWith(record);
  });

  it('refreshes the account when the organization-projects flag changes', async () => {
    whenReadyMock.mockResolvedValue(undefined);

    await import('../index');
    await waitForAppReady();

    expect(installOrgProjectsCapabilityRefreshMock).toHaveBeenCalledTimes(1);
    const deps = installOrgProjectsCapabilityRefreshMock.mock.calls[0]?.[0];
    if (!deps) throw new Error('Expected capability refresh dependencies');
    isFeatureFlagEnabledMock.mockImplementation(
      (key) => key === 'canopy-shared-org-projects-enabled',
    );
    expect(deps.flags.isEnabled()).toBe(true);
    const listener = (): void => undefined;
    deps.flags.onSnapshotChanged(listener);
    expect(onFeatureFlagSnapshotChangedMock).toHaveBeenCalledWith(listener);
  });

  it('loads model registries before starting preference-writing services', async () => {
    whenReadyMock.mockResolvedValue(undefined);

    await import('../index');
    await waitForAppReady();

    expect(loadModelsFromPackageJsonMock).toHaveBeenCalledTimes(1);
    expect(refreshAgentModelsFromStoreMock).toHaveBeenCalledTimes(1);
    expect(startOrgEnforcedSettingsSyncMock).toHaveBeenCalledTimes(1);
    expect(migrateApprovalDefaultsToFullAccessMock).toHaveBeenCalledTimes(1);
    expect(migrateApprovalDefaultsToFullAccessMock).toHaveBeenCalledWith(true);
    expect(
      loadModelsFromPackageJsonMock.mock.invocationCallOrder[0],
    ).toBeLessThan(
      migrateApprovalDefaultsToFullAccessMock.mock.invocationCallOrder[0] ?? 0,
    );
    expect(
      refreshAgentModelsFromStoreMock.mock.invocationCallOrder[0],
    ).toBeLessThan(
      migrateApprovalDefaultsToFullAccessMock.mock.invocationCallOrder[0] ?? 0,
    );
    expect(
      loadModelsFromPackageJsonMock.mock.invocationCallOrder[0],
    ).toBeLessThan(
      startOrgEnforcedSettingsSyncMock.mock.invocationCallOrder[0] ?? 0,
    );
    expect(
      refreshAgentModelsFromStoreMock.mock.invocationCallOrder[0],
    ).toBeLessThan(
      startOrgEnforcedSettingsSyncMock.mock.invocationCallOrder[0] ?? 0,
    );
    expect(hydrateAiGatewayModelCatalogMock).toHaveBeenCalledTimes(1);
    expect(startAiGatewayModelCatalogMock).toHaveBeenCalledTimes(1);
    expect(
      hydrateAiGatewayModelCatalogMock.mock.invocationCallOrder[0],
    ).toBeLessThan(
      refreshAgentModelsFromStoreMock.mock.invocationCallOrder[0] ?? 0,
    );
  });

  it('runs preference migrations before reading preferences for the window', async () => {
    whenReadyMock.mockResolvedValue(undefined);

    await import('../index');
    await waitForAppReady();

    expect(capturePreferenceMigrationSnapshotsMock).toHaveBeenCalledTimes(1);
    expect(migrateChatSummaryModelSelectionMock).toHaveBeenCalledWith({
      hasPersistedPreferences: true,
      model: 'claude-haiku-4-5-20251001',
      marker: true,
    });
    expect(migrateLocalMemoryModelFromSummaryMock).toHaveBeenCalledWith({
      hasPersistedPreferences: true,
      localMemoryModelSetByUser: false,
      summaryModel: 'claude-haiku-4-5-20251001',
    });
    expect(migrateApprovalDefaultsToFullAccessMock).toHaveBeenCalledTimes(1);
    expect(
      foreignActivityCarryoverServiceMock.initialize,
    ).toHaveBeenCalledTimes(1);
    expect(initializeOllamaServiceMock).toHaveBeenCalledTimes(1);
    expect(refreshAgentModelsFromStoreMock).toHaveBeenCalledTimes(1);
    expect(migrateClaudeWorkerModesToCanopyMock).toHaveBeenCalledTimes(1);
    expect(migrateSidebarRemoteControlVisibleMock).toHaveBeenCalledTimes(1);
    // The sidebar migration must complete before the window is created, or the
    // renderer's first paint shows the pre-migration layout.
    expect(browserWindowMock).toHaveBeenCalled();
    expect(
      capturePreferenceMigrationSnapshotsMock.mock.invocationCallOrder[0],
    ).toBeLessThan(
      migrateApprovalDefaultsToFullAccessMock.mock.invocationCallOrder[0] ?? 0,
    );
    expect(
      initializeOllamaServiceMock.mock.invocationCallOrder[0],
    ).toBeLessThan(
      refreshAgentModelsFromStoreMock.mock.invocationCallOrder[0] ?? 0,
    );
    expect(
      refreshAgentModelsFromStoreMock.mock.invocationCallOrder[0],
    ).toBeLessThan(
      migrateApprovalDefaultsToFullAccessMock.mock.invocationCallOrder[0] ?? 0,
    );
    expect(
      migrateApprovalDefaultsToFullAccessMock.mock.invocationCallOrder[0],
    ).toBeLessThan(
      migrateChatSummaryModelSelectionMock.mock.invocationCallOrder[0] ?? 0,
    );
    expect(
      refreshAgentModelsFromStoreMock.mock.invocationCallOrder[0],
    ).toBeLessThan(
      migrateLocalMemoryModelFromSummaryMock.mock.invocationCallOrder[0] ?? 0,
    );
    expect(
      migrateApprovalDefaultsToFullAccessMock.mock.invocationCallOrder[0],
    ).toBeLessThan(browserWindowMock.mock.invocationCallOrder[0] ?? 0);
    expect(
      migrateSidebarRemoteControlVisibleMock.mock.invocationCallOrder[0],
    ).toBeLessThan(browserWindowMock.mock.invocationCallOrder[0] ?? 0);
    // The More pages migration moves keys out of the layout the Remote
    // Control migration has just upgraded, so it must run second.
    expect(migrateSidebarMorePagesToMainMock).toHaveBeenCalledTimes(1);
    expect(
      migrateSidebarRemoteControlVisibleMock.mock.invocationCallOrder[0],
    ).toBeLessThan(
      migrateSidebarMorePagesToMainMock.mock.invocationCallOrder[0] ?? 0,
    );
    expect(
      migrateSidebarMorePagesToMainMock.mock.invocationCallOrder[0],
    ).toBeLessThan(browserWindowMock.mock.invocationCallOrder[0] ?? 0);
    // The renderer hydrates the Projects sort mode on first paint, so the
    // manual-default migration must land before the window exists.
    expect(migrateSidebarManualSortDefaultMock).toHaveBeenCalledTimes(1);
    expect(
      migrateSidebarManualSortDefaultMock.mock.invocationCallOrder[0],
    ).toBeLessThan(browserWindowMock.mock.invocationCallOrder[0] ?? 0);
    // The renderer reads where links open on first paint, so the built-in
    // browser default lands before the window exists too.
    expect(
      migrateOpenAppLinksInBuiltInBrowserDefaultMock,
    ).toHaveBeenCalledTimes(1);
    expect(
      migrateOpenAppLinksInBuiltInBrowserDefaultMock.mock
        .invocationCallOrder[0],
    ).toBeLessThan(browserWindowMock.mock.invocationCallOrder[0] ?? 0);
  });

  it('rebuilds Agent models and broadcasts a live catalog refresh', async () => {
    whenReadyMock.mockResolvedValue(undefined);

    await import('../index');
    await waitForAppReady();
    const listener = mockAiGatewayCatalogListener;
    if (!listener) {
      throw new Error('Expected the catalog listener to be registered');
    }
    await listener({ version: 1, models: [] });

    expect(updateAiGatewayModelCatalogMock).toHaveBeenCalledWith({
      version: 1,
      models: [],
    });
    expect(refreshAgentModelsFromStoreMock).toHaveBeenCalledTimes(2);
    expect(broadcastModelRegistryUpdatedMock).toHaveBeenCalledTimes(1);
  });

  it('broadcasts a registry update when the catalog status changes', async () => {
    whenReadyMock.mockResolvedValue(undefined);

    await import('../index');
    await waitForAppReady();
    const onStatus = mockAiGatewayStatusListener;
    if (!onStatus) {
      throw new Error('Expected the catalog status listener to be registered');
    }
    broadcastModelRegistryUpdatedMock.mockClear();
    onStatus('failed');
    onStatus('failed');
    expect(broadcastModelRegistryUpdatedMock).toHaveBeenCalledTimes(1);
    onStatus('ready');
    expect(broadcastModelRegistryUpdatedMock).toHaveBeenCalledTimes(2);
  });

  it('projects only the non-guest account domain to PostHog even when Datadog is disabled', async () => {
    whenReadyMock.mockResolvedValue(undefined);
    initializeDesktopInstrumentationMainMock.mockResolvedValue({
      enabled: false,
      provider: 'datadog',
      reason: 'disabled',
    });
    loadCanopyCloudAccountMock.mockResolvedValue({
      authMode: 'oauth',
      credentialSource: 'oauth_desktop',
      account: { email: 'private@UnstoppableDomains.com' },
    });
    await import('../index');
    await waitForAppReady();
    const instrumentation = jest.requireMock<
      jest.Mocked<typeof DesktopInstrumentationMainModule>
    >('@canopy/desktop-instrumentation/electron/main');
    const source = instrumentation.initializePostHogMain.mock.calls[0]?.[1];
    if (!source) throw new Error('Expected a PostHog account source');
    await expect(source.getSnapshot()).resolves.toBe('unstoppabledomains.com');
    const changed = jest.fn();
    const unsubscribe = source.onSnapshotChanged(changed);
    const listener =
      subscribeCanopyCloudAccountChangesMock.mock.calls.at(-1)?.[0];
    listener?.({
      authMode: 'guest',
      credentialSource: 'guest',
      account: { email: 'guest@example.invalid' },
    });
    expect(changed).toHaveBeenLastCalledWith(null);
    listener?.({
      authMode: 'oauth',
      credentialSource: 'oauth_desktop',
      account: { email: 'other@OTHER.TEST' },
    });
    expect(changed).toHaveBeenLastCalledWith('other.test');
    listener?.(null);
    expect(changed).toHaveBeenLastCalledWith(null);
    expect(setDesktopInstrumentationUserMock).not.toHaveBeenCalled();
    unsubscribe();
  });

  // Every preload blocks in a sync `datadog:bridge-config` IPC; an uncloneable
  // reply is never sent and no renderer mounts.
  it('passes the crash dump filter to Datadog while the preload bridge config reply stays cloneable', async () => {
    whenReadyMock.mockResolvedValue(undefined);

    await import('../index');
    await waitForAppReady();

    expect(initializeDesktopInstrumentationMainMock).toHaveBeenCalledTimes(1);
    const options = initializeDesktopInstrumentationMainMock.mock.calls[0]?.[0];
    expect(typeof options?.crashDumpFilter).toBe('function');
    await expect(patchedSdkBridgeConfigFor(options)).resolves.toStrictEqual({
      allowedWebViewHosts: [],
      defaultPrivacyLevel: 'mask',
    });
  });

  it('sets the anonymous telemetry user after instrumentation init succeeds', async () => {
    whenReadyMock.mockResolvedValue(undefined);
    initializeDesktopInstrumentationMainMock.mockResolvedValue({
      enabled: true,
      provider: 'datadog',
    });

    await import('../index');
    await waitForAppReady();
    await waitForImmediate();

    expect(getStableAnonymousKeyMock).toHaveBeenCalledTimes(1);
    expect(setDesktopInstrumentationUserMock).toHaveBeenCalledWith(
      '11111111-2222-4333-8444-555555555555',
      undefined,
    );
  });

  it('still sets the anonymous telemetry user when cloud account loading fails', async () => {
    whenReadyMock.mockResolvedValue(undefined);
    initializeDesktopInstrumentationMainMock.mockResolvedValue({
      enabled: true,
      provider: 'datadog',
    });
    loadCanopyCloudAccountMock.mockRejectedValue(
      new Error('secure storage unavailable'),
    );

    await import('../index');
    await waitForAppReady();
    await waitForImmediate();

    expect(initializeFeatureFlagServiceMock).toHaveBeenCalledTimes(1);
    expect(initializeLabsExperimentsServiceMock).toHaveBeenCalledTimes(1);
    expect(setDesktopInstrumentationUserMock).toHaveBeenCalledWith(
      '11111111-2222-4333-8444-555555555555',
      undefined,
    );
  });

  it('keeps the telemetry email synced to the non-guest cloud account', async () => {
    whenReadyMock.mockResolvedValue(undefined);
    initializeDesktopInstrumentationMainMock.mockResolvedValue({
      enabled: true,
      provider: 'datadog',
    });
    loadCanopyCloudAccountMock.mockResolvedValue({
      authMode: 'oauth',
      credentialSource: 'oauth_desktop',
      account: { email: 'first@example.test' },
    });

    await import('../index');
    await waitForAppReady();
    await waitForImmediate();

    expect(setDesktopInstrumentationUserMock).toHaveBeenCalledWith(
      '11111111-2222-4333-8444-555555555555',
      'first@example.test',
    );

    // Every startup subscriber (telemetry, workspace context, ...) receives
    // each account change in production, so fan the entries out to all of them
    // rather than assuming which subscription was registered last.
    const listeners = subscribeCanopyCloudAccountChangesMock.mock.calls.map(
      ([listener]) => listener,
    );
    for (const listener of listeners) {
      listener?.({
        authMode: 'oauth',
        credentialSource: 'oauth_desktop',
        account: { email: 'next@example.test' },
      });
    }
    for (const listener of listeners) {
      listener?.({
        authMode: 'guest',
        credentialSource: 'guest',
        account: { email: 'guest@example.invalid' },
      });
    }

    expect(setDesktopInstrumentationUserMock).toHaveBeenNthCalledWith(
      2,
      '11111111-2222-4333-8444-555555555555',
      'next@example.test',
    );
    expect(setDesktopInstrumentationUserMock).toHaveBeenNthCalledWith(
      3,
      '11111111-2222-4333-8444-555555555555',
      undefined,
    );
  });

  it('uses the internal app user model id for internal builds', async () => {
    Reflect.set(globalThis, '__CANOPY_RELEASE_FLAVOR__', 'internal');
    whenReadyMock.mockResolvedValue(undefined);

    await import('../index');
    await waitForAppReady();

    const { electronApp } = jest.requireMock<{
      electronApp: { setAppUserModelId: jest.Mock };
    }>('@electron-toolkit/utils');
    expect(electronApp.setAppUserModelId).toHaveBeenCalledWith(
      `${BRAND.appId}.dev`,
    );
  });

  it('uses the display name for the runtime safeStorage identity', async () => {
    Reflect.set(globalThis, '__CANOPY_RELEASE_FLAVOR__', 'rc');
    whenReadyMock.mockResolvedValue(undefined);
    jest.doMock('@canopy/brand/current', () => ({
      BRAND: {
        ...BRAND,
        displayName: 'Unstoppable Code',
        shortName: 'Unstoppable',
      },
    }));

    await import('../index');
    await waitForAppReady();

    const { app } = jest.requireMock<{
      app: { setName: jest.Mock };
    }>('electron');
    expect(app.setName).toHaveBeenCalledWith('Unstoppable Code (RC)');
    expect(app.setName).not.toHaveBeenCalledWith('Unstoppable (RC)');
  });

  it('sets Linux desktop identity after locking and before readiness', async () => {
    const restorePlatform = setPlatform('linux');
    const originalDesktopName = process.env.CHROME_DESKTOP;
    const originalE2e: unknown = Reflect.get(globalThis, '__CANOPY_E2E__');
    Reflect.set(globalThis, '__CANOPY_E2E__', false);
    Reflect.set(globalThis, '__CANOPY_RELEASE_FLAVOR__', 'rc');
    process.env.CHROME_DESKTOP = 'electron.desktop';
    jest.doMock('@canopy/brand/current', () => ({ BRAND }));
    try {
      await import('../index');
      const { app } = jest.requireMock<{
        app: { setName: jest.Mock; requestSingleInstanceLock: jest.Mock };
      }>('electron');
      expect(app.setName).toHaveBeenCalledWith(`${BRAND.displayName} (RC)`);
      expect(process.env.CHROME_DESKTOP).toBe(
        `${BRAND.cliName}-desktop.desktop`,
      );
      expect(
        app.requestSingleInstanceLock.mock.invocationCallOrder[0],
      ).toBeLessThan(
        app.setName.mock.invocationCallOrder[0] ?? Number.POSITIVE_INFINITY,
      );
      expect(app.setName.mock.invocationCallOrder[0]).toBeLessThan(
        whenReadyMock.mock.invocationCallOrder[0] ?? Number.POSITIVE_INFINITY,
      );
    } finally {
      if (typeof originalE2e === 'boolean')
        Reflect.set(globalThis, '__CANOPY_E2E__', originalE2e);
      else Reflect.deleteProperty(globalThis, '__CANOPY_E2E__');
      restorePlatform();
      if (originalDesktopName === undefined) delete process.env.CHROME_DESKTOP;
      else process.env.CHROME_DESKTOP = originalDesktopName;
    }
  });

  it('pins out-of-process sandboxed iframes before the app is ready', async () => {
    appCommandLineGetSwitchValueMock.mockReturnValueOnce('SomeFeature');

    await import('../index');

    // Agent visuals run in their own renderer process; existing features stay.
    expect(appCommandLineAppendSwitchMock).toHaveBeenCalledWith(
      'enable-features',
      'SomeFeature,IsolateSandboxedIframes',
    );
    expect(
      appCommandLineAppendSwitchMock.mock.invocationCallOrder[0],
    ).toBeLessThan(
      whenReadyMock.mock.invocationCallOrder[0] ?? Number.POSITIVE_INFINITY,
    );
  });

  it('configures Linux secure storage before the app is ready', async () => {
    const restorePlatform = setPlatform('linux');
    try {
      await import('../index');

      expect(appCommandLineAppendSwitchMock).toHaveBeenCalledWith(
        'password-store',
        'gnome-libsecret',
      );
      expect(setUsePlainTextEncryptionMock).toHaveBeenCalledTimes(1);
      expect(setUsePlainTextEncryptionMock).toHaveBeenCalledWith(false);
      expect(whenReadyMock).toHaveBeenCalledTimes(1);
      expect(
        setUsePlainTextEncryptionMock.mock.invocationCallOrder[0],
      ).toBeLessThan(whenReadyMock.mock.invocationCallOrder[0]);
    } finally {
      restorePlatform();
    }
  });

  it('leaves macOS secure storage settings unchanged at startup', async () => {
    const restorePlatform = setPlatform('darwin');
    try {
      await import('../index');

      expect(appCommandLineAppendSwitchMock).not.toHaveBeenCalledWith(
        'password-store',
        expect.anything(),
      );
      expect(setUsePlainTextEncryptionMock).not.toHaveBeenCalled();
      expect(whenReadyMock).toHaveBeenCalledTimes(1);
    } finally {
      restorePlatform();
    }
  });

  describe('E2E userData isolation (__CANOPY_E2E__)', () => {
    const originalCanopyDataDir = process.env.CANOPY_DATA_DIR;
    let e2eDataDir: string;

    beforeEach(() => {
      e2eDataDir = mkdtempSync(join(tmpdir(), 'index-e2e-userdata-'));
    });

    afterEach(() => {
      // The jest global default for this seam is `false`; restore it so the
      // redirect never leaks into sibling tests that exercise `whenReady`.
      Reflect.set(globalThis, '__CANOPY_E2E__', false);
      if (originalCanopyDataDir === undefined) {
        delete process.env.CANOPY_DATA_DIR;
      } else {
        process.env.CANOPY_DATA_DIR = originalCanopyDataDir;
      }
      rmSync(e2eDataDir, { recursive: true, force: true });
    });

    it('redirects Electron userData to CANOPY_DATA_DIR in E2E builds', async () => {
      Reflect.set(globalThis, '__CANOPY_E2E__', true);
      process.env.CANOPY_DATA_DIR = e2eDataDir;
      whenReadyMock.mockResolvedValue(undefined);

      await import('../index');
      await waitForAppReady();

      expect(appSetPathMock).toHaveBeenCalledWith('userData', e2eDataDir);
    });

    // Perf launches E2E builds, so they must enroll with production's trigger.
    it('enrolls branch observation at first paint plus 5 s in E2E builds, not at ready', async () => {
      Reflect.set(globalThis, '__CANOPY_E2E__', true);
      whenReadyMock.mockResolvedValue(undefined);
      const createdWindows: Array<ReturnType<typeof createBrowserWindowStub>> =
        [];
      browserWindowMock.mockImplementation(() => {
        const stub = createBrowserWindowStub();
        createdWindows.push(stub);
        return stub;
      });

      await import('../index');
      await waitForAppReady();

      const branchWatcher = jest.requireMock<{
        startWorktreeBranchObserver: jest.Mock<void, [Record<string, unknown>]>;
        startWorktreeBranchEnrollment: jest.Mock;
      }>('../lib/worktree-branch-watcher');
      expect(branchWatcher.startWorktreeBranchObserver).toHaveBeenCalledTimes(
        1,
      );
      const observerOptions =
        branchWatcher.startWorktreeBranchObserver.mock.calls[0]?.[0] ?? {};
      // No option beyond these two: nothing enrolls before the window.
      expect(Object.keys(observerOptions).sort()).toEqual([
        'dispatcher',
        'getWindow',
      ]);
      expect(typeof observerOptions['getWindow']).toBe('function');
      expect(
        branchWatcher.startWorktreeBranchEnrollment,
      ).not.toHaveBeenCalled();

      const mainWindow = createdWindows[0];
      if (!mainWindow) throw new Error('Expected the main window');
      const firstLoad = mainWindow.webContents.once.mock.calls.find(
        ([event]) => event === 'did-finish-load',
      )?.[1];
      if (!firstLoad) throw new Error('Expected a first-load listener');
      // The suite's timer tracker spies on setTimeout and clears its timers.
      const timeouts = jest.spyOn(globalThis, 'setTimeout');
      const scheduledBefore = timeouts.mock.calls.length;
      firstLoad();
      const fallback = timeouts.mock.calls
        .slice(scheduledBefore)
        .find(
          ([callback]) =>
            callback === branchWatcher.startWorktreeBranchEnrollment,
        );
      expect(fallback?.[1]).toBe(5_000);
      expect(
        branchWatcher.startWorktreeBranchEnrollment,
      ).not.toHaveBeenCalled();
    });

    it('does not redirect userData when the E2E seam is off', async () => {
      Reflect.set(globalThis, '__CANOPY_E2E__', false);
      process.env.CANOPY_DATA_DIR = e2eDataDir;
      whenReadyMock.mockResolvedValue(undefined);

      await import('../index');
      await waitForAppReady();

      expect(appSetPathMock).not.toHaveBeenCalledWith(
        'userData',
        expect.anything(),
      );
    });

    it('does not redirect userData when CANOPY_DATA_DIR is unset', async () => {
      Reflect.set(globalThis, '__CANOPY_E2E__', true);
      delete process.env.CANOPY_DATA_DIR;
      whenReadyMock.mockResolvedValue(undefined);

      await import('../index');
      await waitForAppReady();

      expect(appSetPathMock).not.toHaveBeenCalledWith(
        'userData',
        expect.anything(),
      );
    });

    it('does not redirect userData when CANOPY_DATA_DIR does not exist on disk', async () => {
      Reflect.set(globalThis, '__CANOPY_E2E__', true);
      process.env.CANOPY_DATA_DIR = join(e2eDataDir, 'missing-subdir');
      whenReadyMock.mockResolvedValue(undefined);

      await import('../index');
      await waitForAppReady();

      expect(appSetPathMock).not.toHaveBeenCalledWith(
        'userData',
        expect.anything(),
      );
    });
  });

  it('does not set the anonymous telemetry user when instrumentation is disabled', async () => {
    whenReadyMock.mockResolvedValue(undefined);

    await import('../index');
    await waitForAppReady();
    await waitForImmediate();

    expect(setDesktopInstrumentationUserMock).not.toHaveBeenCalled();
  });

  it('never queries or changes launch at sign-in during startup', async () => {
    const restorePlatform = setPlatform('darwin');
    whenReadyMock.mockResolvedValue(undefined);
    appIsInApplicationsFolderMock.mockReturnValue(true);
    const { app: electronAppMock } = jest.requireMock<{
      app: { isPackaged: boolean };
    }>('electron');
    electronAppMock.isPackaged = true;

    try {
      await import('../index');
      await waitForAppReady();
      getRegisteredWindowAccessors().notifyStartupUnlocked();

      expect(browserWindowMock).toHaveBeenCalledTimes(1);
      expect(appGetLoginItemSettingsMock).not.toHaveBeenCalled();
      expect(appSetLoginItemSettingsMock).not.toHaveBeenCalled();
    } finally {
      electronAppMock.isPackaged = false;
      restorePlatform();
    }
  });

  it('schedules deferred startup background tasks after startup is unlocked', async () => {
    whenReadyMock.mockResolvedValue(undefined);

    await import('../index');
    await waitForAppReady();

    expect(scheduleDeferredStartupBackgroundTasksMock).not.toHaveBeenCalled();

    getRegisteredWindowAccessors().notifyStartupUnlocked();

    expect(scheduleDeferredStartupBackgroundTasksMock).toHaveBeenCalledTimes(1);
    expect(startOnboardingProfileSyncMock).toHaveBeenCalledTimes(1);
    expect(startCuratedMcpRefreshMock).toHaveBeenCalledTimes(1);
    expect(
      scheduleDeferredStartupBackgroundTasksMock.mock.invocationCallOrder[0],
    ).toBeGreaterThan(browserWindowMock.mock.invocationCallOrder[0]);
  });

  it('cancels scheduled startup background tasks during app cleanup', async () => {
    whenReadyMock.mockResolvedValue(undefined);

    await import('../index');
    await waitForAppReady();

    getRegisteredWindowAccessors().notifyStartupUnlocked();

    const beforeQuit = eventHandlers.get('before-quit');
    expect(beforeQuit).toBeDefined();
    beforeQuit?.({ preventDefault: jest.fn() });
    await waitForImmediate();

    expect(cancelStartupBackgroundTasksMock).toHaveBeenCalledTimes(1);
    expect(disposeOnboardingProfileSyncMock).toHaveBeenCalledTimes(1);
    expect(disposeCuratedMcpRefreshMock).toHaveBeenCalledTimes(1);
  });

  it('allows audio media permission on macOS when microphone access is granted', async () => {
    const restorePlatform = setPlatform('darwin');
    getMediaAccessStatusMock.mockReturnValue('granted');
    whenReadyMock.mockResolvedValue(undefined);
    let createdWindow: ReturnType<typeof createBrowserWindowStub> | undefined;
    browserWindowMock.mockImplementation(() => {
      createdWindow = createBrowserWindowStub();
      return createdWindow;
    });

    try {
      await import('../index');
      await waitForAppReady();

      const handler = getPermissionRequestHandler(createdWindow);
      const audioCallback = jest.fn();
      const videoCallback = jest.fn();
      const mixedCallback = jest.fn();

      await handler({}, 'media', audioCallback, { mediaTypes: ['audio'] });
      await handler({}, 'media', videoCallback, { mediaTypes: ['video'] });
      await handler({}, 'media', mixedCallback, {
        mediaTypes: ['audio', 'video'],
      });

      expect(audioCallback).toHaveBeenCalledWith(true);
      expect(videoCallback).toHaveBeenCalledWith(false);
      expect(mixedCallback).toHaveBeenCalledWith(false);
    } finally {
      restorePlatform();
    }
  });

  it('denies audio media on macOS when microphone access is not granted', async () => {
    const restorePlatform = setPlatform('darwin');
    getMediaAccessStatusMock.mockReturnValue('not-determined');
    whenReadyMock.mockResolvedValue(undefined);
    let createdWindow: ReturnType<typeof createBrowserWindowStub> | undefined;
    browserWindowMock.mockImplementation(() => {
      createdWindow = createBrowserWindowStub();
      return createdWindow;
    });

    try {
      await import('../index');
      await waitForAppReady();

      const handler = getPermissionRequestHandler(createdWindow);
      const callback = jest.fn();

      await handler({}, 'media', callback, { mediaTypes: ['audio'] });

      expect(callback).toHaveBeenCalledWith(false);
    } finally {
      restorePlatform();
    }
  });

  it('denies audio media permission on Windows', async () => {
    const restorePlatform = setPlatform('win32');
    whenReadyMock.mockResolvedValue(undefined);
    let createdWindow: ReturnType<typeof createBrowserWindowStub> | undefined;
    browserWindowMock.mockImplementation(() => {
      createdWindow = createBrowserWindowStub();
      return createdWindow;
    });

    try {
      await import('../index');
      await waitForAppReady();

      const handler = getPermissionRequestHandler(createdWindow);
      const callback = jest.fn();

      await handler({}, 'media', callback, { mediaTypes: ['audio'] });

      expect(callback).toHaveBeenCalledWith(false);
    } finally {
      restorePlatform();
    }
  });

  it('records renderer lifecycle diagnostics and recovery reload edges', async () => {
    jest.useFakeTimers();
    whenReadyMock.mockResolvedValue(undefined);
    let createdWindow: ReturnType<typeof createBrowserWindowStub> | undefined;
    browserWindowMock.mockImplementation(() => {
      createdWindow = createBrowserWindowStub();
      return createdWindow;
    });

    await import('../index');
    await waitForAppReady();

    if (!createdWindow) {
      throw new Error('Expected BrowserWindow to be created');
    }

    const didFailLoad = createdWindow.webContentsHandlers.get('did-fail-load');
    const consoleMessage =
      createdWindow.webContentsHandlers.get('console-message');
    const renderProcessGone = createdWindow.webContentsHandlers.get(
      'render-process-gone',
    );
    const unresponsive = createdWindow.windowHandlers.get('unresponsive');
    const responsive = createdWindow.windowHandlers.get('responsive');

    didFailLoad?.(undefined, -1, 'boom', 'http://localhost', true);
    consoleMessage?.({
      level: 'error',
      message: 'renderer exploded',
      sourceId: 'renderer.js',
      lineNumber: 12,
    });
    renderProcessGone?.(undefined, { reason: 'crashed', exitCode: 9 });
    unresponsive?.();
    responsive?.();
    jest.runOnlyPendingTimers();

    expect(recordAppDiagnosticMock).toHaveBeenCalledWith(
      expect.objectContaining({
        kind: 'renderer_did_fail_load',
      }),
    );
    expect(recordAppDiagnosticMock).toHaveBeenCalledWith(
      expect.objectContaining({
        kind: 'renderer_console_error',
        sourceId: 'renderer.js',
        lineNumber: 12,
      }),
    );
    expect(recordAppDiagnosticMock).toHaveBeenCalledWith(
      expect.objectContaining({
        kind: 'renderer_process_gone',
        reason: 'crashed',
        exitCode: 9,
      }),
    );
    expect(recordAppDiagnosticMock).toHaveBeenCalledWith(
      expect.objectContaining({
        kind: 'renderer_reload_scheduled',
      }),
    );
    expect(recordAppDiagnosticMock).toHaveBeenCalledWith(
      expect.objectContaining({
        kind: 'renderer_unresponsive',
      }),
    );
    expect(recordAppDiagnosticMock).toHaveBeenCalledWith(
      expect.objectContaining({
        kind: 'renderer_responsive',
      }),
    );
    jest.useRealTimers();
  });

  it.each<NodeJS.Platform>(['linux', 'darwin', 'win32'])(
    'uses the first-activation show path for %s without a URI or second activation',
    async (platform) => {
      const restorePlatform = setPlatform(platform);
      whenReadyMock.mockResolvedValue(undefined);
      const window = createBrowserWindowStub();
      browserWindowMock.mockReturnValue(window);
      try {
        await import('../index');
        await waitForAppReady();

        // No URI or second activation: Linux must map its surface before
        // Wayland can supply the frame that would emit ready-to-show.
        expect(browserWindowMock).toHaveBeenCalledWith(
          expect.objectContaining({ show: platform === 'linux' }),
        );
        expect(browserWindowMock.mock.calls[0]?.[0]?.backgroundColor).toBe(
          platform === 'linux' ? '#F2F2ED' : undefined,
        );
        expect(window.show).not.toHaveBeenCalled();
        window.windowHandlers.get('ready-to-show')?.();
        expect(window.show).toHaveBeenCalledTimes(platform === 'linux' ? 0 : 1);
      } finally {
        restorePlatform();
      }
    },
  );

  it.each(['dark', 'system'] as const)(
    'maps the first Linux window with a dark recipe when %s resolves dark',
    async (colorMode) => {
      const restorePlatform = setPlatform('linux');
      const { nativeTheme } = await import('electron');
      Object.assign(nativeTheme, { shouldUseDarkColors: true });
      readPreferencesFileMock.mockResolvedValue({
        theme: 'dusk',
        colorMode,
        windowBounds: null,
        windowMaximized: false,
        windowFullScreen: false,
      });
      whenReadyMock.mockResolvedValue(undefined);
      const window = createBrowserWindowStub();
      browserWindowMock.mockReturnValue(window);
      try {
        await import('../index');
        await waitForAppReady();
        expect(nativeTheme.themeSource).toBe(colorMode);
        expect(browserWindowMock).toHaveBeenCalledWith(
          expect.objectContaining({ show: true, backgroundColor: '#131419' }),
        );
      } finally {
        Object.assign(nativeTheme, { shouldUseDarkColors: false });
        restorePlatform();
      }
    },
  );

  it('keeps the first Linux window hidden during headless automation', async () => {
    const restorePlatform = setPlatform('linux');
    Reflect.set(globalThis, '__CANOPY_E2E__', true);
    whenReadyMock.mockResolvedValue(undefined);
    const window = createBrowserWindowStub();
    browserWindowMock.mockReturnValue(window);
    try {
      await import('../index');
      await waitForAppReady();
      expect(browserWindowMock).toHaveBeenCalledWith(
        expect.objectContaining({ show: false }),
      );
      window.windowHandlers.get('ready-to-show')?.();
      expect(window.show).not.toHaveBeenCalled();
    } finally {
      Reflect.set(globalThis, '__CANOPY_E2E__', false);
      restorePlatform();
    }
  });

  describe.each(['main', 'Advisor'] as const)('%s window chrome', (family) => {
    it.each<NodeJS.Platform>(['darwin', 'win32', 'linux'])(
      'uses the expected window chrome on %s',
      async (platform) => {
        const restorePlatform = setPlatform(platform);
        whenReadyMock.mockResolvedValue(undefined);
        const windowOptions: Electron.BrowserWindowConstructorOptions[] = [];
        browserWindowMock.mockImplementation((options) => {
          windowOptions.push(options ?? {});
          return createBrowserWindowStub();
        });
        try {
          await import('../index');
          await waitForAppReady();
          if (family === 'Advisor') {
            await getRegisteredWindowAccessors().openAppAdvisorWindow({
              layout: 'full',
              focus: false,
            });
          }
          const options = windowOptions[family === 'main' ? 0 : 1];
          if (!options) throw new Error('Expected constructed window options');
          if (platform === 'linux') {
            expect(options.frame).toBe(true);
            expect(options).not.toHaveProperty('titleBarStyle');
            expect(options).not.toHaveProperty('trafficLightPosition');
          } else {
            expect(options.titleBarStyle).toBe('hiddenInset');
            expect(options.trafficLightPosition).toEqual({
              x: 16,
              y: family === 'main' ? 16 : 15,
            });
            expect(options).not.toHaveProperty('frame');
          }
          expect(options).not.toHaveProperty('titleBarOverlay');
        } finally {
          restorePlatform();
        }
      },
    );
  });

  it('opens the graduated Advisor as a floating view without the legacy toggle', async () => {
    whenReadyMock.mockResolvedValue(undefined);
    browserWindowMock.mockImplementation(() => {
      const window = createBrowserWindowStub();
      window.isVisible.mockReturnValue(true);
      return window;
    });
    await import('../index');
    await waitForAppReady();
    const result = await getRegisteredWindowAccessors().openAppAdvisorWindow({
      focus: false,
    });
    expect(result).toMatchObject({ open: true, layout: 'floating' });
    expect(webContentsViewMock).toHaveBeenCalledTimes(1);
    const viewResult = webContentsViewMock.mock.results[0];
    const shellResult = browserWindowMock.mock.results[1];
    if (viewResult?.type !== 'return' || shellResult?.type !== 'return')
      throw new Error('Expected App Advisor view and shell');
    expect(viewResult.value.setVisible).toHaveBeenCalledWith(true);
    expect(shellResult.value.show).not.toHaveBeenCalled();
    expect(advisorRenderer().webContents).not.toBe(
      shellResult.value.webContents,
    );
  });

  it('reveals the App Advisor window for background agent opens without stealing OS focus (CAN-1993)', async () => {
    whenReadyMock.mockResolvedValue(undefined);
    const createdWindows: Array<ReturnType<typeof createBrowserWindowStub>> =
      [];
    browserWindowMock.mockImplementation(() => {
      const stub = createBrowserWindowStub();
      createdWindows.push(stub);
      return stub;
    });
    getFocusedWindowMock.mockReturnValue(null);

    await import('../index');
    await waitForAppReady();
    const accessors = getRegisteredWindowAccessors();

    // No app window has OS focus: the user is working in another application.
    await accessors.openAppAdvisorWindow({
      layout: 'full',
      focus: true,
      background: true,
    });
    const appAdvisorWindow = createdWindows[1];
    expect(appAdvisorWindow?.showInactive).toHaveBeenCalledTimes(1);
    expect(appAdvisorWindow?.show).not.toHaveBeenCalled();
    expect(appAdvisorWindow?.focus).not.toHaveBeenCalled();
    expect(appAdvisorWindow?.moveTop).not.toHaveBeenCalled();

    // The user is back in this app: the same request may raise the window.
    getFocusedWindowMock.mockReturnValue(createdWindows[0] ?? null);
    await accessors.openAppAdvisorWindow({
      layout: 'full',
      focus: true,
      background: true,
    });
    expect(appAdvisorWindow?.show).toHaveBeenCalledTimes(1);
    expect(appAdvisorWindow?.focus).toHaveBeenCalledTimes(1);
    expect(appAdvisorWindow?.moveTop).toHaveBeenCalledTimes(1);
    expect(appAdvisorWindow?.showInactive).toHaveBeenCalledTimes(1);
  });

  it('creates and reuses the standalone App Advisor window', async () => {
    whenReadyMock.mockResolvedValue(undefined);
    const originalRendererUrl = process.env['ELECTRON_RENDERER_URL'];
    process.env['ELECTRON_RENDERER_URL'] = 'http://localhost:5173';
    const createdWindows: Array<ReturnType<typeof createBrowserWindowStub>> =
      [];
    const createdWindowOptions: BrowserWindowOptionsUnderTest[] = [];
    browserWindowMock.mockImplementation((options) => {
      const stub = createBrowserWindowStub();
      createdWindows.push(stub);
      createdWindowOptions.push(options ?? {});
      return stub;
    });

    try {
      await import('../index');
      await waitForAppReady();

      const accessors = getRegisteredWindowAccessors();

      await accessors.openAppAdvisorWindow({ layout: 'full', focus: true });
      await accessors.openAppAdvisorWindow({ layout: 'full', focus: true });

      expect(browserWindowMock).toHaveBeenCalledTimes(2);
      const appAdvisorWindow = createdWindows[1];
      const appAdvisorOptions =
        createdWindowOptions[createdWindowOptions.length - 1];
      if (!appAdvisorOptions) {
        throw new Error('Expected App Advisor BrowserWindow options');
      }
      expect(appAdvisorOptions).toMatchObject({
        title: 'Orchestrator',
        minWidth: 360,
        minHeight: 420,
        show: false,
      });
      expect(appAdvisorOptions.webPreferences).toMatchObject({
        contextIsolation: true,
        spellcheck: true,
      });
      expect(advisorRenderer().loadURL).toHaveBeenCalledWith(
        'http://localhost:5173/app-advisor.html?surface=app-advisor',
      );
      expect(appAdvisorWindow?.show).toHaveBeenCalledTimes(2);
      expect(appAdvisorWindow?.focus).toHaveBeenCalledTimes(2);
      expect(appAdvisorWindow?.moveTop).toHaveBeenCalledTimes(2);

      await expect(
        accessors.openAppAdvisorWindow({
          layout: 'full',
          focus: true,
          chatId: 'Invalid Chat!',
        }),
      ).rejects.toThrow(
        'Invalid chatId: must be lowercase alphanumeric with hyphens',
      );
      expect(resolveWorkEntryForChatMock).not.toHaveBeenCalled();

      resolveWorkEntryForChatMock.mockResolvedValueOnce({
        entryId: null,
        archivedInEntryId: null,
      });
      readChatArchivesFileMock.mockResolvedValueOnce({
        version: 1,
        archived: [{ tab: { id: 'legacy-chat' } }],
      });
      await expect(
        accessors.openAppAdvisorWindow({
          layout: 'full',
          focus: true,
          chatId: 'legacy-chat',
        }),
      ).resolves.toEqual({
        open: false,
        focused: false,
        minimized: false,
        layout: 'full',
        floatingSize: { width: 400, height: 640 },
        mainWindowOpen: true,
      });
      expect(readChatArchivesFileMock).toHaveBeenCalledWith(
        'app-advisor',
        'global',
      );
    } finally {
      if (originalRendererUrl === undefined) {
        delete process.env['ELECTRON_RENDERER_URL'];
      } else {
        process.env['ELECTRON_RENDERER_URL'] = originalRendererUrl;
      }
    }
  });

  it('loads each window from its own packaged renderer page', async () => {
    whenReadyMock.mockResolvedValue(undefined);
    const originalRendererUrl = process.env['ELECTRON_RENDERER_URL'];
    delete process.env['ELECTRON_RENDERER_URL'];
    const createdWindows: Array<ReturnType<typeof createBrowserWindowStub>> =
      [];
    browserWindowMock.mockImplementation(() => {
      const stub = createBrowserWindowStub();
      createdWindows.push(stub);
      return stub;
    });

    try {
      await import('../index');
      await waitForAppReady();
      await getRegisteredWindowAccessors().openAppAdvisorWindow({
        layout: 'full',
        focus: true,
      });

      expect(createdWindows[0]?.loadFile).toHaveBeenCalledWith(
        join(__dirname, '..', '../renderer', 'index.html'),
      );
      expect(advisorRenderer().loadFile).toHaveBeenCalledWith(
        join(__dirname, '..', '../renderer', 'app-advisor.html'),
        { search: '?surface=app-advisor' },
      );
      // The off path is today's path: the setting is read, nothing loads
      // over the renderer scheme, and each window loads its file once,
      // handed back by the controller once no origin change is in flight.
      expect(mockRendererOriginPrepare).toHaveBeenCalledWith(false);
      expect(mockRendererOriginLoadWindow).toHaveBeenNthCalledWith(1, {
        surface: 'main',
        window: createdWindows[0],
      });
      expect(mockRendererOriginLoadWindow.mock.calls[1]?.[0]?.surface).toBe(
        'app-advisor',
      );
      expect(
        mockRendererOriginLoadWindow.mock.calls[1]?.[0]?.window.webContents,
      ).toBe(advisorRenderer().webContents);
      expect(createdWindows[0]?.loadFile).toHaveBeenCalledTimes(1);
      expect(advisorRenderer().loadFile).toHaveBeenCalledTimes(1);
      expect(createdWindows[0]?.loadURL).not.toHaveBeenCalled();
      expect(advisorRenderer().loadURL).not.toHaveBeenCalled();
    } finally {
      if (originalRendererUrl !== undefined) {
        process.env['ELECTRON_RENDERER_URL'] = originalRendererUrl;
      }
    }
  });

  it('loads both windows over the renderer scheme when this launch uses it', async () => {
    whenReadyMock.mockResolvedValue(undefined);
    const originalRendererUrl = process.env['ELECTRON_RENDERER_URL'];
    delete process.env['ELECTRON_RENDERER_URL'];
    readPreferencesFileMock.mockResolvedValue({
      windowBounds: null,
      windowMaximized: false,
      windowFullScreen: false,
      appAdvisorDialogBounds: null,
      ollamaServerPort: 11534,
      rendererCodeCacheSchemeEnabled: true,
    });
    mockRendererOrigin.origin = 'scheme';
    const createdWindows: Array<ReturnType<typeof createBrowserWindowStub>> =
      [];
    browserWindowMock.mockImplementation(() => {
      const stub = createBrowserWindowStub();
      createdWindows.push(stub);
      return stub;
    });

    try {
      await import('../index');
      await waitForAppReady();
      await getRegisteredWindowAccessors().openAppAdvisorWindow({
        layout: 'full',
        focus: true,
      });

      expect(mockRendererOriginPrepare).toHaveBeenCalledWith(true);
      expect(mockRendererOriginLoadWindow).toHaveBeenNthCalledWith(1, {
        surface: 'main',
        window: createdWindows[0],
      });
      expect(mockRendererOriginLoadWindow.mock.calls[1]?.[0]?.surface).toBe(
        'app-advisor',
      );
      expect(
        mockRendererOriginLoadWindow.mock.calls[1]?.[0]?.window.webContents,
      ).toBe(advisorRenderer().webContents);
      expect(createdWindows[0]?.loadFile).not.toHaveBeenCalled();
      expect(advisorRenderer().loadFile).not.toHaveBeenCalled();
    } finally {
      mockRendererOrigin.origin = 'file';
      if (originalRendererUrl !== undefined) {
        process.env['ELECTRON_RENDERER_URL'] = originalRendererUrl;
      }
    }
  });

  it('registers the renderer scheme privileges before ready and skips it on the dev server', async () => {
    whenReadyMock.mockResolvedValue(undefined);
    const originalRendererUrl = process.env['ELECTRON_RENDERER_URL'];
    process.env['ELECTRON_RENDERER_URL'] = 'http://localhost:5173';
    browserWindowMock.mockImplementation(() => createBrowserWindowStub());

    try {
      await import('../index');
      expect(mockRegisterRendererSchemePrivileges).toHaveBeenCalledTimes(1);
      await waitForAppReady();
      expect(mockRendererOriginPrepare).not.toHaveBeenCalled();
      expect(mockRendererOriginStartRecordProbe).not.toHaveBeenCalled();
    } finally {
      if (originalRendererUrl === undefined) {
        delete process.env['ELECTRON_RENDERER_URL'];
      } else {
        process.env['ELECTRON_RENDERER_URL'] = originalRendererUrl;
      }
    }
  });

  it('decides the renderer origin even when a later startup step never finishes', async () => {
    whenReadyMock.mockResolvedValue(undefined);
    const originalRendererUrl = process.env['ELECTRON_RENDERER_URL'];
    delete process.env['ELECTRON_RENDERER_URL'];
    // A startup step that runs after preferences are read, before the first
    // window, never settles. Windows the tray or the shortcut opens wait for
    // the origin decision, so it must not sit behind that step.
    let refreshCalls = 0;
    jest.doMock('../browser/default-browser-registration', () => {
      const actual = jest.requireActual<
        typeof DefaultBrowserRegistrationModule
      >('../browser/default-browser-registration');
      return {
        ...actual,
        getDefaultBrowserRegistrationService: (): ReturnType<
          typeof actual.getDefaultBrowserRegistrationService
        > => {
          const service = actual.getDefaultBrowserRegistrationService();
          service.refresh = (): Promise<never> => {
            refreshCalls += 1;
            return new Promise<never>(() => undefined);
          };
          return service;
        },
      };
    });

    try {
      await import('../index');
      await waitForAppReady();
      expect(refreshCalls).toBe(1);
      expect(mockRendererOriginPrepare).toHaveBeenCalledTimes(1);
      expect(mockRendererOriginPrepare).toHaveBeenCalledWith(false);
    } finally {
      jest.dontMock('../browser/default-browser-registration');
      if (originalRendererUrl !== undefined) {
        process.env['ELECTRON_RENDERER_URL'] = originalRendererUrl;
      }
    }
  });

  it('routes windows created while the renderer origin is being prepared through the controller', async () => {
    whenReadyMock.mockResolvedValue(undefined);
    const originalRendererUrl = process.env['ELECTRON_RENDERER_URL'];
    delete process.env['ELECTRON_RENDERER_URL'];
    let releasePrepare: () => void = () => undefined;
    const prepared = new Promise<'file' | 'scheme'>((resolve) => {
      releasePrepare = (): void => resolve('file');
    });
    mockRendererOriginPrepare.mockImplementation(() => prepared);
    // The controller holds every load until its origin decision settles.
    mockRendererOriginLoadWindow.mockImplementation(async (target) => {
      await prepared;
      await mockLoadThroughController(target);
    });
    const createdWindows: Array<ReturnType<typeof createBrowserWindowStub>> =
      [];
    browserWindowMock.mockImplementation(() => {
      const stub = createBrowserWindowStub();
      createdWindows.push(stub);
      return stub;
    });

    try {
      await import('../index');
      await waitForAppReady();
      expect(mockRendererOriginPrepare).toHaveBeenCalledTimes(1);
      expect(createdWindows).toHaveLength(0);

      // The tray (or the global shortcut) recreates the main window, and an
      // automation opens App Advisor, while storage is still being copied.
      mockTrayOptions.current?.onOpen();
      const advisorOpen = getRegisteredWindowAccessors().openAppAdvisorWindow({
        layout: 'full',
        focus: false,
      });
      await waitForAppReady();

      const [main, advisor] = createdWindows;
      expect(main).toBeDefined();
      expect(advisor).toBeDefined();
      for (const created of [main, advisor]) {
        expect(created?.loadFile).not.toHaveBeenCalled();
        expect(created?.loadURL).not.toHaveBeenCalled();
      }
      expect(mockRendererOriginLoadWindow).toHaveBeenCalledWith({
        surface: 'main',
        window: main,
      });

      releasePrepare();
      await advisorOpen;
      await waitForAppReady();
      expect(main?.loadFile).toHaveBeenCalledWith(
        join(__dirname, '..', '../renderer', 'index.html'),
      );
      expect(advisorRenderer().loadFile).toHaveBeenCalledWith(
        join(__dirname, '..', '../renderer', 'app-advisor.html'),
        { search: '?surface=app-advisor' },
      );
    } finally {
      if (originalRendererUrl !== undefined) {
        process.env['ELECTRON_RENDERER_URL'] = originalRendererUrl;
      }
    }
  });

  describe('runtime IPC trust follows the launch origin', () => {
    function senderAt(
      created: ReturnType<typeof createBrowserWindowStub> | undefined,
      url: string,
    ): DesktopIpcEvent {
      if (!created) throw new Error('Expected the main window');
      const mainFrame = Object.assign(created.webContents.mainFrame, { url });
      const sender = Object.assign(created.webContents, {
        id: 7,
        mainFrame,
        getURL: (): string => url,
      });
      return { sender, senderFrame: mainFrame };
    }

    async function startWith(schemeEnabled: boolean): Promise<{
      resolveCaller: (event: DesktopIpcEvent) => unknown;
      main: ReturnType<typeof createBrowserWindowStub> | undefined;
    }> {
      whenReadyMock.mockResolvedValue(undefined);
      readPreferencesFileMock.mockResolvedValue({
        windowBounds: null,
        windowMaximized: false,
        windowFullScreen: false,
        appAdvisorDialogBounds: null,
        ollamaServerPort: 11534,
        rendererCodeCacheSchemeEnabled: schemeEnabled,
      });
      // The scheme's pages become trusted only once prepare has decided.
      mockRendererOriginPrepare.mockImplementation((enabled) => {
        mockRendererOrigin.origin = enabled ? 'scheme' : 'file';
        mockRendererOrigin.trusted = enabled
          ? MOCK_SCHEME_PAGE_URLS
          : MOCK_FILE_PAGE_URLS;
        return Promise.resolve(mockRendererOrigin.origin);
      });
      const createdWindows: Array<ReturnType<typeof createBrowserWindowStub>> =
        [];
      browserWindowMock.mockImplementation(() => {
        const stub = createBrowserWindowStub();
        createdWindows.push(stub);
        return stub;
      });
      await import('../index');
      await waitForAppReady();
      const resolveCaller =
        mockRegisterAllIpcHandlers.mock.calls[0]?.[1]?.resolveCaller;
      if (!resolveCaller) throw new Error('Expected a runtime IPC caller');
      return { resolveCaller, main: createdWindows[0] };
    }

    let originalRendererUrl: string | undefined;
    beforeEach(() => {
      originalRendererUrl = process.env['ELECTRON_RENDERER_URL'];
      delete process.env['ELECTRON_RENDERER_URL'];
    });
    afterEach(() => {
      if (originalRendererUrl !== undefined) {
        process.env['ELECTRON_RENDERER_URL'] = originalRendererUrl;
      }
    });

    it('trusts the scheme pages, and not file://, when the launch uses the scheme', async () => {
      const { resolveCaller, main } = await startWith(true);
      expect(mockRendererOriginPrepare).toHaveBeenCalledWith(true);
      expect(
        resolveCaller(senderAt(main, 'app-renderer://bundle/index.html')),
      ).toMatchObject({ interfaceKind: 'desktop' });
      expect(() =>
        resolveCaller(senderAt(main, MOCK_FILE_PAGE_URLS[0] ?? '')),
      ).toThrow(/Untrusted desktop IPC sender/);
    });

    it('trusts the file:// pages as today, and not the scheme, when it is off', async () => {
      const { resolveCaller, main } = await startWith(false);
      expect(
        resolveCaller(senderAt(main, MOCK_FILE_PAGE_URLS[0] ?? '')),
      ).toMatchObject({ interfaceKind: 'desktop' });
      expect(() =>
        resolveCaller(senderAt(main, 'app-renderer://bundle/index.html')),
      ).toThrow(/Untrusted desktop IPC sender/);
    });
  });

  it('leaves a crashed window to the renderer-origin fallback instead of reloading it', async () => {
    jest.useFakeTimers();
    whenReadyMock.mockResolvedValue(undefined);
    const originalRendererUrl = process.env['ELECTRON_RENDERER_URL'];
    delete process.env['ELECTRON_RENDERER_URL'];
    const createdWindows: Array<ReturnType<typeof createBrowserWindowStub>> =
      [];
    browserWindowMock.mockImplementation(() => {
      const stub = createBrowserWindowStub();
      createdWindows.push(stub);
      return stub;
    });

    try {
      await import('../index');
      await waitForAppReady();
      await getRegisteredWindowAccessors().openAppAdvisorWindow({
        layout: 'full',
        focus: false,
      });
      const [main, advisor] = createdWindows;
      mockRendererOrigin.fallingBack = true;
      for (const created of [main, advisor]) {
        created?.webContentsHandlers.get('render-process-gone')?.(undefined, {
          reason: 'crashed',
          exitCode: 9,
        });
      }
      jest.advanceTimersByTime(250);
      expect(main?.webContents.reload).not.toHaveBeenCalled();
      expect(advisorRenderer().webContents.reload).not.toHaveBeenCalled();
    } finally {
      jest.useRealTimers();
      if (originalRendererUrl !== undefined) {
        process.env['ELECTRON_RENDERER_URL'] = originalRendererUrl;
      }
    }
  });

  it('forwards every archived container viewer tab to App Advisor', async () => {
    whenReadyMock.mockResolvedValue(undefined);
    const originalRendererUrl = process.env['ELECTRON_RENDERER_URL'];
    process.env['ELECTRON_RENDERER_URL'] = 'http://localhost:5173';
    const createdWindows: Array<ReturnType<typeof createBrowserWindowStub>> =
      [];
    const commands: AppAdvisorWindowCommand[] = [];
    browserWindowMock.mockImplementation(() => {
      const stub = createBrowserWindowStub();
      createdWindows.push(stub);
      if (createdWindows.length === 2) {
        configureAdvisorRenderer = (stub): void => {
          stub.webContents.send.mockImplementation((channel, command) => {
            if (channel === IPC_CHANNELS.appAdvisorWindowCommand) {
              commands.push(command as AppAdvisorWindowCommand);
            }
          });
        };
      }
      return stub;
    });

    try {
      await import('../index');
      await waitForAppReady();

      const accessors = getRegisteredWindowAccessors();
      await accessors.openAppAdvisorWindow({ layout: 'full', focus: true });
      accessors.markAppAdvisorWindowRendererReady(
        advisorRenderer().webContents as unknown as WebContents,
      );

      await accessors.openAppAdvisorWindow(
        Object.assign(
          { chatId: 'chat-1', focus: true },
          { delegationId: 'delegate-1' },
        ),
      );
      expect(
        commands.filter((command) => command.type === 'select_chat'),
      ).toEqual([
        { type: 'select_chat', chatId: 'chat-1', delegationId: 'delegate-1' },
      ]);

      await expect(
        accessors.openAppAdvisorWindow({
          layout: 'full',
          delegationId: 'delegate-1',
        }),
      ).rejects.toThrow('delegationId requires chatId.');
      await expect(
        accessors.openAppAdvisorWindow({
          layout: 'full',
          chatId: 'chat-1',
          delegationId: '../bad-id',
        }),
      ).rejects.toThrow();
      resolveWorkEntryForChatMock.mockResolvedValueOnce({
        entryId: null,
        archivedInEntryId: 'entry-1',
      });
      await accessors.openAppAdvisorWindow({
        layout: 'full',
        chatId: 'archived-chat',
        delegationId: 'delegate-1',
      });
      expect(
        commands.filter((command) => command.type === 'select_chat').at(-1),
      ).toEqual({ type: 'select_chat', chatId: 'archived-chat' });

      for (const tab of ['attachments', 'plans'] as const) {
        await accessors.openAppAdvisorWindow({
          layout: 'full',
          focus: true,
          archivedContainer: {
            containerId: 'archive-1',
            tab,
          },
        });
      }
      await accessors.openAppAdvisorWindow({
        layout: 'full',
        focus: true,
        archivedOverview: {},
      });
      await accessors.openAppAdvisorWindow({
        layout: 'full',
        focus: true,
        archivedOverview: { openEmptyTrashConfirmation: true },
      });

      expect(
        commands.filter(
          (command) => command.type === 'open_archived_container',
        ),
      ).toEqual([
        {
          type: 'open_archived_container',
          containerId: 'archive-1',
          tab: 'attachments',
        },
        {
          type: 'open_archived_container',
          containerId: 'archive-1',
          tab: 'plans',
        },
      ]);
      expect(readArchivedContainerManifestMock).toHaveBeenCalledTimes(2);
      expect(
        commands.filter((command) => command.type === 'open_archived_overview'),
      ).toEqual([
        { type: 'open_archived_overview' },
        {
          type: 'open_archived_overview',
          openEmptyTrashConfirmation: true,
        },
      ]);
    } finally {
      if (originalRendererUrl === undefined) {
        delete process.env['ELECTRON_RENDERER_URL'];
      } else {
        process.env['ELECTRON_RENDERER_URL'] = originalRendererUrl;
      }
    }
  });

  it('sends App Advisor quick prompts after the standalone window finishes loading', async () => {
    whenReadyMock.mockResolvedValue(undefined);
    const originalRendererUrl = process.env['ELECTRON_RENDERER_URL'];
    process.env['ELECTRON_RENDERER_URL'] = 'http://localhost:5173';
    const events: string[] = [];
    const createdWindows: Array<ReturnType<typeof createBrowserWindowStub>> =
      [];
    browserWindowMock.mockImplementation(() => {
      const stub = createBrowserWindowStub();
      createdWindows.push(stub);
      if (createdWindows.length === 2) {
        configureAdvisorRenderer = (stub): void => {
          stub.loadURL.mockImplementation(() => {
            events.push('loadURL:start');
            stub.webContentsHandlers.get('did-finish-load')?.();
            events.push('loadURL:end');
          });
          stub.webContents.send.mockImplementation((channel, command) => {
            if (
              channel === IPC_CHANNELS.appAdvisorWindowCommand &&
              typeof command === 'object' &&
              command !== null &&
              'type' in command
            ) {
              events.push(`command:${String(command.type)}`);
            }
          });
        };
      }
      return stub;
    });

    try {
      await import('../index');
      await waitForAppReady();

      const accessors = getRegisteredWindowAccessors();
      await accessors.openAppAdvisorWindow({
        layout: 'full',
        focus: true,
        focusComposer: true,
        quickPrompt: '   Debug this failed run',
        quickPromptFileReferences: [
          { displayPath: 'Debug', absolutePath: '/repo/Debug', textStart: 3 },
        ],
        quickPromptTitle: 'Debug Build pipeline',
        quickPromptChatId: 'debug-chat',
      });

      expect(events).toEqual(['loadURL:start', 'loadURL:end']);
      expect(createWorkEntryMock).toHaveBeenCalledTimes(1);
      expect(createWorkEntryMock.mock.calls[0]?.[0]).toBe('app-advisor');
      const createdEntryOptions = createWorkEntryMock.mock.calls[0]?.[1];
      expect(createdEntryOptions).toMatchObject({
        id: 'debug-chat',
        title: 'Debug Build pipeline',
      });
      expect(
        typeof createdEntryOptions === 'object' &&
          createdEntryOptions !== null &&
          'createdAt' in createdEntryOptions &&
          typeof createdEntryOptions.createdAt === 'string',
      ).toBe(true);

      accessors.markAppAdvisorWindowRendererReady(
        advisorRenderer().webContents as unknown as WebContents,
      );

      expect(events).toEqual([
        'loadURL:start',
        'loadURL:end',
        'command:send_quick_prompt',
        'command:focus_composer',
      ]);
      expect(advisorRenderer().webContents.send).toHaveBeenCalledWith(
        IPC_CHANNELS.appAdvisorWindowCommand,
        expect.objectContaining({
          type: 'send_quick_prompt',
          text: '   Debug this failed run',
          replaceActiveEmpty: true,
          fileReferences: [
            { displayPath: 'Debug', absolutePath: '/repo/Debug', textStart: 3 },
          ],
        }),
      );
      listWorkEntriesMock.mockResolvedValueOnce([{ id: 'existing-entry' }]);
      await accessors.openAppAdvisorWindow({
        layout: 'full',
        quickPrompt: 'Targeted follow-up',
        quickPromptWorkEntryId: 'existing-entry',
      });
      expect(createWorkEntryMock).toHaveBeenCalledTimes(1);
      expect(advisorRenderer().webContents.send).toHaveBeenCalledWith(
        IPC_CHANNELS.appAdvisorWindowCommand,
        expect.objectContaining({
          type: 'send_quick_prompt',
          entryId: 'existing-entry',
          replaceActiveEmpty: false,
        }),
      );
    } finally {
      if (originalRendererUrl === undefined) {
        delete process.env['ELECTRON_RENDERER_URL'];
      } else {
        process.env['ELECTRON_RENDERER_URL'] = originalRendererUrl;
      }
    }
  });

  it('ignores App Advisor renderer-ready acknowledgements from other windows', async () => {
    whenReadyMock.mockResolvedValue(undefined);
    const originalRendererUrl = process.env['ELECTRON_RENDERER_URL'];
    process.env['ELECTRON_RENDERER_URL'] = 'http://localhost:5173';
    const events: string[] = [];
    const createdWindows: Array<ReturnType<typeof createBrowserWindowStub>> =
      [];
    browserWindowMock.mockImplementation(() => {
      const stub = createBrowserWindowStub();
      createdWindows.push(stub);
      if (createdWindows.length === 2) {
        configureAdvisorRenderer = (stub): void => {
          stub.loadURL.mockImplementation(() => {
            stub.webContentsHandlers.get('did-finish-load')?.();
          });
          stub.webContents.send.mockImplementation((channel, command) => {
            if (
              channel === IPC_CHANNELS.appAdvisorWindowCommand &&
              typeof command === 'object' &&
              command !== null &&
              'type' in command
            ) {
              events.push(`command:${String(command.type)}`);
            }
          });
        };
      }
      return stub;
    });

    try {
      await import('../index');
      await waitForAppReady();

      const accessors = getRegisteredWindowAccessors();
      await accessors.openAppAdvisorWindow({
        layout: 'full',
        focus: true,
        quickPrompt: 'Debug this failed run',
        quickPromptChatId: 'debug-chat',
      });

      accessors.markAppAdvisorWindowRendererReady(
        createdWindows[0]?.webContents as unknown as WebContents,
      );

      expect(events).toEqual([]);

      accessors.markAppAdvisorWindowRendererReady(
        advisorRenderer().webContents as unknown as WebContents,
      );

      expect(events).toEqual(['command:send_quick_prompt']);
    } finally {
      if (originalRendererUrl === undefined) {
        delete process.env['ELECTRON_RENDERER_URL'];
      } else {
        process.env['ELECTRON_RENDERER_URL'] = originalRendererUrl;
      }
    }
  });

  it('defers pending App Advisor ask-user redelivery until the next tick', async () => {
    jest.useFakeTimers();
    whenReadyMock.mockResolvedValue(undefined);
    const originalRendererUrl = process.env['ELECTRON_RENDERER_URL'];
    process.env['ELECTRON_RENDERER_URL'] = 'http://localhost:5173';
    const toolRequestEvents: string[] = [];
    const createdWindows: Array<ReturnType<typeof createBrowserWindowStub>> =
      [];
    browserWindowMock.mockImplementation(() => {
      const stub = createBrowserWindowStub();
      createdWindows.push(stub);
      if (createdWindows.length === 2) {
        configureAdvisorRenderer = (stub): void => {
          stub.loadURL.mockImplementation(() => {
            stub.webContentsHandlers.get('did-finish-load')?.();
          });
          stub.webContents.send.mockImplementation((channel, request) => {
            if (
              channel === IPC_CHANNELS.appAdvisorToolRequest &&
              typeof request === 'object' &&
              request !== null &&
              'kind' in request
            ) {
              toolRequestEvents.push(String(request.kind));
            }
          });
        };
      }
      return stub;
    });

    try {
      await import('../index');
      await waitForAppReady();

      const { requestAppAdvisorRendererTool } =
        await import('../ipc/app-advisor');
      const accessors = getRegisteredWindowAccessors();
      await accessors.openAppAdvisorWindow({ layout: 'full', focus: true });
      const appAdvisorWindow = createdWindows[1];
      if (!appAdvisorWindow) {
        throw new Error('Expected App Advisor window to be created');
      }
      const requestPromise = requestAppAdvisorRendererTool(
        {
          kind: 'ask_user_question',
          requestId: 'deferred-ask-redelivery',
          question: {
            id: 'question-1',
            question: 'Pick one',
            options: ['A'],
          },
        },
        {
          getMainWindow: () => null,
          getAppAdvisorWindow: () =>
            appAdvisorWindow as unknown as BrowserWindow,
          openAppAdvisorWindow: jest.fn(() =>
            Promise.resolve({ open: true, focused: true }),
          ),
          ensureAppAdvisorWindow: jest.fn(() =>
            Promise.resolve({ open: true, focused: true }),
          ),
        },
      );
      for (let index = 0; index < 4; index += 1) {
        await Promise.resolve();
      }

      expect(toolRequestEvents).toEqual(['ask_user_question']);

      toolRequestEvents.length = 0;
      accessors.markAppAdvisorWindowRendererReady(
        advisorRenderer().webContents as unknown as WebContents,
      );

      expect(toolRequestEvents).toEqual([]);

      jest.advanceTimersByTime(0);

      expect(toolRequestEvents).toEqual(['ask_user_question']);

      jest.advanceTimersByTime(ASK_USER_TIMEOUT_MS);
      await expect(requestPromise).resolves.toMatchObject({
        ok: false,
        error: { code: 'timeout' },
      });
    } finally {
      jest.useRealTimers();
      if (originalRendererUrl === undefined) {
        delete process.env['ELECTRON_RENDERER_URL'];
      } else {
        process.env['ELECTRON_RENDERER_URL'] = originalRendererUrl;
      }
    }
  });

  it('hides App Advisor on user-visible close and persists bounds', async () => {
    whenReadyMock.mockResolvedValue(undefined);
    const createdWindows: Array<ReturnType<typeof createBrowserWindowStub>> =
      [];
    browserWindowMock.mockImplementation(() => {
      const stub = createBrowserWindowStub();
      createdWindows.push(stub);
      return stub;
    });

    await import('../index');
    await waitForAppReady();

    const accessors = getRegisteredWindowAccessors();

    await accessors.openAppAdvisorWindow({ layout: 'full', focus: true });
    const appAdvisorWindow = createdWindows[1];
    if (!appAdvisorWindow) {
      throw new Error('Expected App Advisor window');
    }

    const close = appAdvisorWindow.windowHandlers.get('close');
    const preventDefault = jest.fn();
    close?.({ preventDefault });

    expect(preventDefault).toHaveBeenCalledTimes(1);
    expect(appAdvisorWindow.hide).toHaveBeenCalledTimes(1);
    expect(writePreferencesFileMock).toHaveBeenCalledWith({
      appAdvisorDialogBounds: {
        x: 10,
        y: 20,
        width: 1200,
        height: 800,
      },
    });
  });

  it('does not let close-to-tray disclosure overwrite newer approval defaults', async () => {
    const restorePlatform = setPlatform('win32');
    whenReadyMock.mockResolvedValue(undefined);
    mockIsCloseToTrayEnabled.mockReturnValue(true);
    let createdWindow: ReturnType<typeof createBrowserWindowStub> | undefined;
    browserWindowMock.mockImplementation(() => {
      createdWindow = createBrowserWindowStub();
      return createdWindow;
    });
    // A partial fixture: these tests rely on unset preferences staying undefined.
    const preferences: Partial<PreferencesData> = {
      windowBounds: null,
      windowMaximized: false,
      windowFullScreen: false,
      appAdvisorDialogBounds: null,
      ollamaServerPort: 11534,
      closeToTray: true,
      approvalDefaults: {
        worktree: 'full-access' as const,
        cowork: 'full-access' as const,
        appAdvisor: 'full-access' as const,
      },
    };
    const staleSnapshot = preferences as PreferencesData;
    readPreferencesFileMock.mockResolvedValue(staleSnapshot);

    try {
      await import('../index');
      await waitForAppReady();
      if (!createdWindow) throw new Error('Expected main window');

      const disclosureRead: {
        release?: (value: PreferencesData) => void;
      } = {};
      readPreferencesFileMock.mockImplementationOnce(
        () =>
          new Promise<PreferencesData>((resolve) => {
            disclosureRead.release = resolve;
          }),
      );
      let persisted: typeof staleSnapshot & {
        closeToTrayDisclosedAt?: string;
      } = { ...staleSnapshot };
      writePreferencesFileMock.mockClear();
      writePreferencesFileMock.mockImplementation(
        (patch: Partial<typeof persisted>) => {
          persisted = { ...persisted, ...patch };
          return Promise.resolve(persisted);
        },
      );

      createdWindow.windowHandlers.get('close')?.({
        preventDefault: jest.fn(),
      });
      await Promise.resolve();
      persisted = {
        ...persisted,
        approvalDefaults: {
          worktree: 'ask',
          cowork: 'full-access',
          appAdvisor: 'full-access',
        },
      };
      disclosureRead.release?.(staleSnapshot);
      await waitForImmediate();

      expect(persisted.approvalDefaults.worktree).toBe('ask');
      const writeCalls = writePreferencesFileMock.mock
        .calls as unknown as Array<[unknown]>;
      const disclosurePatches = writeCalls
        .map(([patch]) => patch)
        .filter(
          (patch): patch is Record<string, unknown> =>
            typeof patch === 'object' &&
            patch !== null &&
            'closeToTrayDisclosedAt' in patch,
        );
      expect(disclosurePatches).toHaveLength(1);
      const [disclosurePatch] = disclosurePatches;
      expect(disclosurePatch).toBeDefined();
      expect(Object.keys(disclosurePatch ?? {})).toEqual([
        'closeToTrayDisclosedAt',
      ]);
      expect(typeof disclosurePatch?.closeToTrayDisclosedAt).toBe('string');
    } finally {
      restorePlatform();
    }
  });

  it('uses the main window default width for a fresh App Advisor window', async () => {
    whenReadyMock.mockResolvedValue(undefined);

    await import('../index');
    await waitForAppReady();

    const accessors = getRegisteredWindowAccessors();
    await accessors.openAppAdvisorWindow({ layout: 'full', focus: true });

    expect(browserWindowMock).toHaveBeenNthCalledWith(
      2,
      expect.objectContaining({ width: 1400 }),
    );
  });

  it('clamps the fresh App Advisor width to the primary display work area', async () => {
    whenReadyMock.mockResolvedValue(undefined);
    getPrimaryDisplayMock.mockReturnValue({
      workArea: { x: 0, y: 0, width: 1024, height: 768 },
    });

    await import('../index');
    await waitForAppReady();

    const accessors = getRegisteredWindowAccessors();
    await accessors.openAppAdvisorWindow({ layout: 'full', focus: true });

    expect(browserWindowMock).toHaveBeenNthCalledWith(
      2,
      expect.objectContaining({ width: 1024 }),
    );
  });

  it('reloads the standalone App Advisor renderer after a crash', async () => {
    jest.useFakeTimers();
    whenReadyMock.mockResolvedValue(undefined);
    const createdWindows: Array<ReturnType<typeof createBrowserWindowStub>> =
      [];
    browserWindowMock.mockImplementation(() => {
      const stub = createBrowserWindowStub();
      createdWindows.push(stub);
      return stub;
    });

    try {
      await import('../index');
      await waitForAppReady();

      const accessors = getRegisteredWindowAccessors();
      await accessors.openAppAdvisorWindow({ layout: 'full', focus: true });

      const appAdvisorWindow = createdWindows[1];
      if (!appAdvisorWindow) {
        throw new Error('Expected App Advisor window');
      }

      advisorRenderer().webContentsHandlers.get('render-process-gone')?.(
        undefined,
        { reason: 'crashed', exitCode: 9 },
      );

      expect(recordAppDiagnosticMock).toHaveBeenCalledWith(
        expect.objectContaining({
          kind: 'renderer_reload_scheduled',
          reason: 'app_advisor_window:crashed',
          exitCode: 9,
        }),
      );

      jest.advanceTimersByTime(250);

      expect(advisorRenderer().webContents.once).toHaveBeenCalledWith(
        'did-finish-load',
        expect.any(Function),
      );
      expect(recordAppDiagnosticMock).toHaveBeenCalledWith(
        expect.objectContaining({
          kind: 'renderer_reload_started',
          reason: 'app_advisor_window',
        }),
      );
      expect(advisorRenderer().webContents.reload).toHaveBeenCalledTimes(1);
    } finally {
      jest.useRealTimers();
    }
  });

  it('validates App Advisor bounds before creating the window', async () => {
    whenReadyMock.mockResolvedValue(undefined);
    const savedBounds = { x: 5000, y: 5000, width: 520, height: 680 };
    const validatedBounds = { x: 100, y: 120, width: 520, height: 680 };
    readPreferencesFileMock.mockResolvedValue({
      windowBounds: null,
      windowMaximized: false,
      windowFullScreen: false,
      appAdvisorDialogBounds: savedBounds,
      ollamaServerPort: 11534,
    });
    getValidateWindowBoundsMock().mockImplementation((bounds, options) =>
      options?.minWidth === 360 ? validatedBounds : bounds,
    );

    await import('../index');
    await waitForAppReady();

    const accessors = getRegisteredWindowAccessors();
    await accessors.openAppAdvisorWindow({ layout: 'full', focus: true });

    expect(getValidateWindowBoundsMock()).toHaveBeenCalledWith(savedBounds, {
      minWidth: 360,
      minHeight: 420,
    });
    expect(browserWindowMock).toHaveBeenLastCalledWith(
      expect.objectContaining(validatedBounds),
    );
  });

  it('quits on non-macOS when the main window closes even if App Advisor is hidden', async () => {
    const restorePlatform = setPlatform('win32');
    whenReadyMock.mockResolvedValue(undefined);
    const createdWindows: Array<ReturnType<typeof createBrowserWindowStub>> =
      [];
    browserWindowMock.mockImplementation(() => {
      const stub = createBrowserWindowStub();
      createdWindows.push(stub);
      return stub;
    });

    try {
      await import('../index');
      await waitForAppReady();

      const accessors = getRegisteredWindowAccessors();
      await accessors.openAppAdvisorWindow({ layout: 'full', focus: true });
      await accessors.closeAppAdvisorWindow();

      createdWindows[0]?.windowHandlers.get('closed')?.();

      expect(appQuitMock).toHaveBeenCalledTimes(1);
    } finally {
      restorePlatform();
    }
  });

  it('recreates the main window on macOS activate when only App Advisor remains', async () => {
    const restorePlatform = setPlatform('darwin');
    whenReadyMock.mockResolvedValue(undefined);
    const createdWindows: Array<ReturnType<typeof createBrowserWindowStub>> =
      [];
    browserWindowMock.mockImplementation(() => {
      const stub = createBrowserWindowStub();
      createdWindows.push(stub);
      return stub;
    });

    try {
      await import('../index');
      await waitForAppReady();

      const accessors = getRegisteredWindowAccessors();
      await accessors.openAppAdvisorWindow({ layout: 'full', focus: true });
      createdWindows[0]?.windowHandlers.get('closed')?.();

      eventHandlers.get('activate')?.();
      await Promise.resolve();
      await Promise.resolve();

      expect(appQuitMock).not.toHaveBeenCalled();
      expect(browserWindowMock).toHaveBeenCalledTimes(3);
    } finally {
      restorePlatform();
    }
  });

  it('focuses the open paired-computer window on macOS activate instead of recreating the main window', async () => {
    const restorePlatform = setPlatform('darwin');
    whenReadyMock.mockResolvedValue(undefined);
    const createdWindows: Array<ReturnType<typeof createBrowserWindowStub>> =
      [];
    browserWindowMock.mockImplementation(() => {
      const stub = createBrowserWindowStub();
      createdWindows.push(stub);
      return stub;
    });
    const remoteWindow = createBrowserWindowStub();
    mockRemoteMachineWindows.current = [remoteWindow];

    try {
      await import('../index');
      await waitForAppReady();
      expect(createdWindows).toHaveLength(1);

      createdWindows[0]?.windowHandlers.get('closed')?.();
      eventHandlers.get('activate')?.();
      await waitForAppReady();

      expect(remoteWindow.show).toHaveBeenCalledTimes(1);
      expect(remoteWindow.focus).toHaveBeenCalledTimes(1);
      expect(browserWindowMock).toHaveBeenCalledTimes(1);
    } finally {
      restorePlatform();
    }
  });

  describe('paired-window quit ownership', () => {
    let shutdown: ReturnType<typeof createQuitTestScope>;

    beforeEach(() => {
      shutdown = createQuitTestScope();
    });

    afterEach(async () => {
      // before-quit is fire-and-forget; drain it before the outer fixture reset,
      // including when a state assertion fails after cleanup has started.
      await shutdown.drain();
    });

    afterEach(() => {
      // A separate hook: Jest still runs it when the drain fails or times out.
      shutdown.restore();
    });

    it("tells a paired computer's windows the app is quitting only once the quit is committed", async () => {
      whenReadyMock.mockResolvedValue(undefined);
      const createdWindow = createBrowserWindowStub();
      browserWindowMock.mockReturnValue(createdWindow);
      await import('../index');
      await waitForAppReady();
      const isAppQuitting =
        mockInitializeRemoteControl.mock.calls[0]?.[0].isAppQuitting;
      const guard = getRegisteredWindowAccessors().unsavedCloseGuard;
      if (!isAppQuitting || !guard) throw new Error('Expected quit wiring');
      const beforeQuit = eventHandlers.get('before-quit');
      if (!beforeQuit) throw new Error('Expected quit hook');

      // Unsaved edits hold the quit for the user, who cancels it.
      guard.setDirty(true);
      beforeQuit({ preventDefault: jest.fn() });
      expect(isAppQuitting()).toBe(false);
      const prompt = createdWindow.webContents.send.mock.calls.find(
        ([channel]) => channel === IPC_CHANNELS.appWindowConfirmClose,
      )?.[1];
      if (
        typeof prompt !== 'object' ||
        prompt === null ||
        !('requestId' in prompt) ||
        typeof prompt.requestId !== 'string'
      ) {
        throw new Error('Expected an unsaved-changes prompt');
      }
      guard.handleShown(prompt.requestId);
      guard.handleDecision(prompt.requestId, false);
      expect(isAppQuitting()).toBe(false);

      guard.setDirty(false);
      shutdown.commit(() => beforeQuit({ preventDefault: jest.fn() }));
      expect(isAppQuitting()).toBe(true);
    });
  });

  it('does not inherit paired-window quit cleanup after the fixture resets', async () => {
    await waitForImmediate();
    expect(appQuitMock).not.toHaveBeenCalled();
    expect(appExitMock).not.toHaveBeenCalled();
    expect(drainMainProcessLoggingMock).not.toHaveBeenCalled();
  });

  describe('quit test scope cleanup', () => {
    const platform = process.platform;
    let originalQuit: ReturnType<typeof appQuitMock.getMockImplementation>;
    let originalExit: ReturnType<typeof appExitMock.getMockImplementation>;
    let scope: ReturnType<typeof createQuitTestScope>;

    beforeEach(() => {
      originalQuit = appQuitMock.getMockImplementation();
      originalExit = appExitMock.getMockImplementation();
      scope = createQuitTestScope();
    });

    afterEach(() => {
      scope.restore();
    });

    function expectFixtureRestored(): void {
      expect(process.platform).toBe(platform);
      expect(appQuitMock.getMockImplementation()).toBe(originalQuit);
      expect(appExitMock.getMockImplementation()).toBe(originalExit);
    }

    it('drains without waiting when quit was never committed', async () => {
      await scope.drain();
      scope.restore();
      expectFixtureRestored();
      expect(appQuitMock).not.toHaveBeenCalled();
      expect(appExitMock).not.toHaveBeenCalled();
    });

    it('keeps the simulated platform while committed cleanup drains to quit', async () => {
      scope.commit(() => undefined);
      let drained = false;
      const draining = scope.drain().then(() => {
        drained = true;
      });
      await waitForImmediate();
      expect(drained).toBe(false);
      expect(process.platform).toBe('linux');

      appQuitMock();
      await draining;
      scope.restore();
      expectFixtureRestored();
    });

    it('rejects cleanup exit rather than treating it as successful quit', async () => {
      scope.commit(() => {
        appExitMock(0);
      });
      await expect(scope.drain()).rejects.toThrow(
        'Expected shutdown cleanup to quit, not exit',
      );
      scope.restore();
      expectFixtureRestored();
    });

    it('does not wait for cleanup when the quit hook throws synchronously', async () => {
      expect(() =>
        scope.commit(() => {
          throw new Error('quit hook threw');
        }),
      ).toThrow('quit hook threw');
      await expect(scope.drain()).resolves.toBeUndefined();
    });

    it('restores the fixture while committed cleanup is still pending', () => {
      scope.commit(() => undefined);
      scope.restore();
      expectFixtureRestored();

      // Restoring twice must not reapply a stale platform descriptor.
      const restorePlatform = setPlatform('win32');
      try {
        scope.restore();
        expect(process.platform).toBe('win32');
      } finally {
        restorePlatform();
      }
    });
  });

  it("recreates the closed main window when a paired computer's window switches back to this computer", async () => {
    const restorePlatform = setPlatform('darwin');
    whenReadyMock.mockResolvedValue(undefined);
    const createdWindows: Array<ReturnType<typeof createBrowserWindowStub>> =
      [];
    browserWindowMock.mockImplementation(() => {
      const stub = createBrowserWindowStub();
      if (createdWindows.length > 0) stub.isVisible.mockReturnValue(true);
      createdWindows.push(stub);
      return stub;
    });
    mockRemoteMachineWindows.current = [createBrowserWindowStub()];

    try {
      await import('../index');
      await waitForAppReady();
      expect(createdWindows).toHaveLength(1);

      createdWindows[0]?.windowHandlers.get('closed')?.();
      mockInitializeRemoteControl.mock.calls[0]?.[0].showMainWindow();
      await waitForAppReady();

      expect(createdWindows).toHaveLength(2);
      expect(createdWindows[1]?.focus).toHaveBeenCalledTimes(1);
    } finally {
      restorePlatform();
    }
  });

  describe('split-lock release on renderer lifecycle events', () => {
    // `beforeEach` above calls `jest.resetModules()`, so `../index`'s OWN
    // `import '../services/split-lock-service'` resolves to a fresh module
    // instance on every test — a DIFFERENT instance than this file's
    // top-level static import. Locks must be acquired/inspected through the
    // same freshly-`import()`ed instance `../index` wires its listeners
    // against, not through the statically-imported `acquireSplitLock` /
    // `isSplitLocked` / `releaseSplitLock` bindings captured before the reset.
    async function createMainWindowForLifecycleTest(): Promise<{
      createdWindow: ReturnType<typeof createBrowserWindowStub>;
      splitLockService: typeof SplitLockServiceModule;
    }> {
      whenReadyMock.mockResolvedValue(undefined);
      let createdWindow: ReturnType<typeof createBrowserWindowStub> | undefined;
      browserWindowMock.mockImplementation(() => {
        createdWindow = createBrowserWindowStub();
        return createdWindow;
      });

      await import('../index');
      await waitForAppReady();

      if (!createdWindow) {
        throw new Error('Expected BrowserWindow to be created');
      }
      const splitLockService = await import('../services/split-lock-service');
      return { createdWindow, splitLockService };
    }

    afterEach(async () => {
      // Belt-and-suspenders against a leaked lock on assertion failure. Uses
      // the CURRENT (post-reset) module instance, matching whichever instance
      // the test above acquired against.
      const splitLockService = await import('../services/split-lock-service');
      splitLockService.releaseSplitLock('main-window-lifecycle-ws', 'wt-idle');
      splitLockService.releaseSplitLock('main-window-lifecycle-ws', 'wt-busy');
    });

    it('releases an idle split lock when did-navigate fires (committed main-frame reload)', async () => {
      const { createdWindow, splitLockService } =
        await createMainWindowForLifecycleTest();
      const didNavigate = createdWindow.webContentsHandlers.get('did-navigate');
      if (!didNavigate) {
        throw new Error('Expected a did-navigate listener to be registered');
      }

      splitLockService.acquireSplitLock('main-window-lifecycle-ws', 'wt-idle');
      expect(
        splitLockService.isSplitLocked('main-window-lifecycle-ws', 'wt-idle'),
      ).toBe(true);

      // `did-navigate`'s real Electron payload is (event, url, httpResponseCode,
      // httpStatusText) — none of which the handler reads, since the event's
      // very existence already means "a main-frame, cross-document navigation
      // just committed". Invoking with no args exercises exactly that contract.
      didNavigate();

      expect(
        splitLockService.isSplitLocked('main-window-lifecycle-ws', 'wt-idle'),
      ).toBe(false);
    });

    it('releases every idle split lock when did-navigate fires, not just the first', async () => {
      const { createdWindow, splitLockService } =
        await createMainWindowForLifecycleTest();
      const didNavigate = createdWindow.webContentsHandlers.get('did-navigate');
      if (!didNavigate) {
        throw new Error('Expected a did-navigate listener to be registered');
      }

      // `releaseIdleSplitLocksForRendererLifecycle` (real, unmocked
      // `../ipc/github`) keeps a lock alive when a main-side split execute is
      // in flight for its key. There is no execute-in-flight seam reachable
      // from this test file, so this asserts the wiring calls the shared
      // helper at all and that it sweeps every held lock, not just one — the
      // execute-in-flight exemption itself is covered directly against
      // `hasInFlightSplitExecute` in `github-split-ipc.test.ts`.
      splitLockService.acquireSplitLock('main-window-lifecycle-ws', 'wt-idle');
      splitLockService.acquireSplitLock('main-window-lifecycle-ws', 'wt-busy');

      didNavigate();

      expect(
        splitLockService.isSplitLocked('main-window-lifecycle-ws', 'wt-idle'),
      ).toBe(false);
      expect(
        splitLockService.isSplitLocked('main-window-lifecycle-ws', 'wt-busy'),
      ).toBe(false);
    });

    it('releases an idle split lock when render-process-gone fires', async () => {
      const { createdWindow, splitLockService } =
        await createMainWindowForLifecycleTest();
      const renderProcessGone = createdWindow.webContentsHandlers.get(
        'render-process-gone',
      );
      if (!renderProcessGone) {
        throw new Error(
          'Expected a render-process-gone listener to be registered',
        );
      }

      splitLockService.acquireSplitLock('main-window-lifecycle-ws', 'wt-idle');
      expect(
        splitLockService.isSplitLocked('main-window-lifecycle-ws', 'wt-idle'),
      ).toBe(true);

      renderProcessGone(undefined, { reason: 'crashed', exitCode: 1 });

      expect(
        splitLockService.isSplitLocked('main-window-lifecycle-ws', 'wt-idle'),
      ).toBe(false);
    });
  });

  describe('link context menu wiring (CAN-2632)', () => {
    async function createMainWindowForLinkMenuTest(): Promise<
      ReturnType<typeof createBrowserWindowStub>
    > {
      whenReadyMock.mockResolvedValue(undefined);
      let createdWindow: ReturnType<typeof createBrowserWindowStub> | undefined;
      browserWindowMock.mockImplementation(() => {
        createdWindow = createBrowserWindowStub();
        return createdWindow;
      });
      await import('../index');
      await waitForAppReady();
      if (!createdWindow) {
        throw new Error('Expected BrowserWindow to be created');
      }
      return createdWindow;
    }

    function linkMenuMock(): {
      attachLinkContextMenu: jest.Mock<
        void,
        [unknown, { canOpenInBrowser: () => boolean }]
      >;
      setLinkBrowserTargetAvailable: jest.Mock<void, [boolean]>;
      shouldOfferOpenInBrowser: jest.Mock<boolean, [unknown]>;
    } {
      return jest.requireMock('../lib/link-context-menu');
    }

    it('resets link target availability on a main-frame reload, not on any load start', async () => {
      const createdWindow = await createMainWindowForLinkMenuTest();
      const { setLinkBrowserTargetAvailable } = linkMenuMock();
      setLinkBrowserTargetAvailable.mockClear();

      // `did-start-loading` also fires for sub-frame loads (iframes), which
      // leave the renderer, and its deduped report, in place.
      createdWindow.webContentsHandlers.get('did-start-loading')?.();
      expect(setLinkBrowserTargetAvailable).not.toHaveBeenCalled();

      createdWindow.webContentsHandlers.get('did-navigate')?.();
      expect(setLinkBrowserTargetAvailable).toHaveBeenCalledWith(false);
    });

    it('reports no notifying main window while its page is crashed or reloading', async () => {
      const createdWindow = await createMainWindowForLinkMenuTest();
      const accessors = getRegisteredWindowAccessors();
      const mainWindowOpen = (): boolean | undefined =>
        accessors.getAppAdvisorWindowState().mainWindowOpen;
      accessors.notifyStartupUnlocked();
      expect(mainWindowOpen()).toBe(true);

      createdWindow.webContentsHandlers.get('render-process-gone')?.(
        undefined,
        { reason: 'crashed', exitCode: 1 },
      );
      expect(mainWindowOpen()).toBe(false);
      accessors.notifyStartupUnlocked();
      expect(mainWindowOpen()).toBe(true);

      createdWindow.webContentsHandlers.get('did-navigate')?.();
      expect(mainWindowOpen()).toBe(false);
      accessors.notifyStartupUnlocked();
      expect(mainWindowOpen()).toBe(true);

      // Sub-frame loads leave the main page in place.
      createdWindow.webContentsHandlers.get('did-start-loading')?.();
      expect(mainWindowOpen()).toBe(true);
    });

    it('keeps routing app links through the renderer after a sub-frame load', async () => {
      const createdWindow = await createMainWindowForLinkMenuTest();
      const appLinkRouter = await import('../browser/app-link-router');
      const routeSafeNavigation = jest
        .spyOn(appLinkRouter, 'routeSafeNavigation')
        .mockResolvedValue('in-app');
      const windowOpenHandler =
        createdWindow.webContents.setWindowOpenHandler.mock.calls[0]?.[0];
      if (!isWindowOpenHandler(windowOpenHandler)) {
        throw new Error('Expected a window open handler');
      }
      const openChatLink = (): unknown =>
        windowOpenHandler({
          url: 'http://127.0.0.1:5195/coordinator.html',
          frameName: '',
          features: '',
          disposition: 'foreground-tab',
          referrer: { url: '', policy: 'default' },
        });
      getRegisteredWindowAccessors().notifyStartupUnlocked();

      // An agent visual or HTML preview iframe in the chat starts loading.
      createdWindow.webContentsHandlers.get('did-start-loading')?.();
      openChatLink();

      // Without the renderer, main cannot place the link in the built-in
      // browser and takes it to the system browser.
      expect(routeSafeNavigation).toHaveBeenLastCalledWith({
        url: 'http://127.0.0.1:5195/coordinator.html',
        sender: createdWindow.webContents,
        source: 'app-link',
      });

      // A committed main-frame reload replaces the renderer.
      createdWindow.webContentsHandlers.get('did-navigate')?.();
      openChatLink();
      expect(routeSafeNavigation).toHaveBeenLastCalledWith(
        expect.objectContaining({ sender: null }),
      );

      getRegisteredWindowAccessors().notifyStartupUnlocked();
      createdWindow.webContentsHandlers.get('render-process-gone')?.(
        undefined,
        { reason: 'crashed', exitCode: 1 },
      );
      openChatLink();
      expect(routeSafeNavigation).toHaveBeenLastCalledWith(
        expect.objectContaining({ sender: null }),
      );
      // The recovery reload commits, then the new renderer reports ready.
      createdWindow.webContentsHandlers.get('did-navigate')?.();
      getRegisteredWindowAccessors().notifyStartupUnlocked();
      openChatLink();
      expect(routeSafeNavigation).toHaveBeenLastCalledWith(
        expect.objectContaining({ sender: createdWindow.webContents }),
      );
      // A later committed main-frame reload replaces it again.
      createdWindow.webContentsHandlers.get('did-navigate')?.();
      openChatLink();
      expect(routeSafeNavigation).toHaveBeenLastCalledWith(
        expect.objectContaining({ sender: null }),
      );
    });

    it('resets link target availability when the main window closes', async () => {
      const createdWindow = await createMainWindowForLinkMenuTest();
      const { setLinkBrowserTargetAvailable } = linkMenuMock();
      setLinkBrowserTargetAvailable.mockClear();

      // Pull-outs that outlive the main window must stop offering the item.
      createdWindow.windowHandlers.get('closed')?.();

      expect(setLinkBrowserTargetAvailable).toHaveBeenCalledWith(false);
    });

    it('decides Open in browser eligibility by window identity, not the renderer URL', async () => {
      const createdWindow = await createMainWindowForLinkMenuTest();
      const { attachLinkContextMenu, shouldOfferOpenInBrowser } =
        linkMenuMock();
      const browserWindowCreated = eventHandlers.get('browser-window-created');
      if (!browserWindowCreated) {
        throw new Error('Expected a browser-window-created listener');
      }
      // A remote-control client window loads the same renderer URL as the
      // main window but shows another computer.
      const otherWindow = createBrowserWindowStub();
      browserWindowCreated(undefined, createdWindow);
      browserWindowCreated(undefined, otherWindow);
      const depsFor = (
        window: unknown,
      ): { canOpenInBrowser: () => boolean } => {
        const call = attachLinkContextMenu.mock.calls.find(
          ([target]) => target === window,
        );
        if (!call) throw new Error('Expected the link menu to be attached');
        return call[1];
      };

      shouldOfferOpenInBrowser.mockClear();
      depsFor(createdWindow).canOpenInBrowser();
      depsFor(otherWindow).canOpenInBrowser();

      expect(shouldOfferOpenInBrowser).toHaveBeenNthCalledWith(
        1,
        expect.objectContaining({ isMainWindow: true }),
      );
      expect(shouldOfferOpenInBrowser).toHaveBeenNthCalledWith(
        2,
        expect.objectContaining({ isMainWindow: false }),
      );
    });
  });

  it('does not leak main-process listeners across entrypoint reloads', () => {
    for (const event of MAIN_PROCESS_EVENTS) {
      expect(process.rawListeners(event)).toEqual(
        initialMainProcessListeners.get(event),
      );
    }
  });
});
