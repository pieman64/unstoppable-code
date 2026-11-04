const mockRecordInviteSend = jest.fn();
const mockRecordInviteAccept = jest.fn();
// Wrappers: SWC hoists jest.mock above the mocks' declarations.
jest.mock('../lib/desktop-telemetry', () => ({
  recordInviteSendTelemetry: (...args: unknown[]): unknown =>
    mockRecordInviteSend(...args),
  recordInviteAcceptTelemetry: (...args: unknown[]): unknown =>
    mockRecordInviteAccept(...args),
}));
import {
  IPC_CHANNELS,
  type SharedContainerAcceptedIdentity,
} from '@canopy/desktop-shared/types';
import { MAX_SHARED_CONTAINER_LIST_LIMIT } from '@canopy/protocol/shared-containers';
import { CanopyCloudClientError } from '../canopy-cloud/client';
import type * as AcceptanceStore from '../shared-containers/acceptance-store';
import type * as CanopyServerClient from '../shared-containers/canopy-server-client';
import type * as PublicationState from '../shared-containers/publication-state';
import type * as RunCopy from '../shared-containers/run/run-copy';
import { storedSecretRef } from '../lib/stored-secrets';
import type * as RunEnvironmentStore from '../shared-containers/run-env-store';
import type * as ScriptRunner from '../lib/script-runner';
import type * as ScriptsService from '../services/scripts-service';
import type * as WorkerTerminal from '../terminal/worker-terminal';

const sendMock = jest.fn();
jest.mock('electron', () => ({
  BrowserWindow: {
    getAllWindows: (): Array<{ webContents: { send: typeof sendMock } }> => [
      { webContents: { send: sendMock } },
    ],
  },
}));

type Handler = (_event: unknown, request: unknown) => Promise<unknown>;
const handlers = new Map<string, Handler>();
jest.mock('../ipc/register', () => ({
  registerIpcHandler: (channel: string, handler: Handler): void => {
    handlers.set(channel, handler);
  },
}));

const isFeatureEnabledMock = jest.fn(() => true);
jest.mock('../feature-flags', () => ({
  getFeatureFlagService: (): { isEnabled: typeof isFeatureEnabledMock } => ({
    isEnabled: isFeatureEnabledMock,
  }),
}));

const isCoworkWorkspaceMock = jest.fn<boolean, [projectId: string]>(
  () => false,
);
jest.mock('../lib/workspace-registry', () => ({
  isCoworkWorkspace: (projectId: string): boolean =>
    isCoworkWorkspaceMock(projectId),
}));

type TrackedPlansWriteListener = (
  projectId: string,
  worktreeId: string,
  file: unknown,
) => void;
let trackedPlansWriteListener: TrackedPlansWriteListener | undefined;
const addTrackedPlansWriteListenerMock = jest.fn(
  (listener: TrackedPlansWriteListener): void => {
    trackedPlansWriteListener = listener;
  },
);
jest.mock('../lib/plan-persistence', () => ({
  get addTrackedPlansWriteListener(): typeof addTrackedPlansWriteListenerMock {
    return addTrackedPlansWriteListenerMock;
  },
}));

const eligibilityMock = jest.fn<Promise<unknown>, unknown[]>();
const prepareGithubMock = jest.fn<Promise<unknown>, unknown[]>();
jest.mock('../shared-containers/eligibility', () => ({
  getSharedContainerEligibility: (...args: unknown[]): Promise<unknown> =>
    eligibilityMock(...args),
  prepareSharedContainerGithub: (...args: unknown[]): Promise<unknown> =>
    prepareGithubMock(...args),
}));
const previewMock = jest.fn<Promise<unknown>, unknown[]>();
const untrackedCandidatesMock = jest.fn<Promise<string[]>, unknown[]>();
jest.mock('../shared-containers/share-preview', () => ({
  buildSharedContainerSharePreview: (...args: unknown[]): Promise<unknown> =>
    previewMock(...args),
  listSharedContainerUntrackedCandidatePaths: (
    ...args: unknown[]
  ): Promise<string[]> => untrackedCandidatesMock(...args),
}));
const createMock = jest.fn<Promise<unknown>, unknown[]>();
const membersMock = jest.fn<Promise<unknown>, unknown[]>();
const recipientsMock = jest.fn<Promise<unknown>, unknown[]>();
const revokeMock = jest.fn<Promise<unknown>, unknown[]>();
// Keep historical server payloads unvalidated; request calls remain strongly typed.
const listByMeMock = jest.fn<
  Promise<unknown>,
  Parameters<typeof CanopyServerClient.listSharedContainersByMe>
>();
const listWithMeMock = jest.fn<Promise<unknown>, unknown[]>();
const getLinkMock = jest.fn<Promise<unknown>, unknown[]>();
const createLinkMock = jest.fn<Promise<unknown>, unknown[]>();
const setLinkMock = jest.fn<Promise<unknown>, unknown[]>();
const resetLinkMock = jest.fn<Promise<unknown>, unknown[]>();
const resolveLinkMock = jest.fn<Promise<unknown>, unknown[]>();
const claimLinkMock = jest.fn<Promise<unknown>, unknown[]>();
const listDismissedMock = jest.fn<Promise<unknown>, unknown[]>();
const restoreMock = jest.fn<Promise<unknown>, unknown[]>();
const signalLocalChangeMock = jest.fn<void, []>();
jest.mock('../services/shared-container-inbox-watcher', () => ({
  getSharedContainerInboxWatcher: (): { signalLocalChange: () => void } => ({
    signalLocalChange: (): void => signalLocalChangeMock(),
  }),
}));
const writeFileScopeMock = jest.fn<Promise<void>, unknown[]>();
const readFileScopeMock = jest.fn<Promise<unknown>, unknown[]>();
const pinPreferredLayoutMock = jest.fn<Promise<boolean>, unknown[]>();
const pinPreferredLayoutIfMissingMock = jest.fn<Promise<boolean>, unknown[]>();
jest.mock('../shared-containers/canopy-server-client', () => ({
  createSharedContainerGrant: (...args: unknown[]): Promise<unknown> =>
    createMock(...args),
  searchSharedContainerMembers: (...args: unknown[]): Promise<unknown> =>
    membersMock(...args),
  listSharedContainerRecipients: (...args: unknown[]): Promise<unknown> =>
    recipientsMock(...args),
  revokeSharedContainerGrant: (...args: unknown[]): Promise<unknown> =>
    revokeMock(...args),
  listSharedContainersByMe: (
    ...args: Parameters<typeof CanopyServerClient.listSharedContainersByMe>
  ): Promise<unknown> => listByMeMock(...args),
  getSharedContainerLink: (...args: unknown[]): Promise<unknown> =>
    getLinkMock(...args),
  createSharedContainerLink: (...args: unknown[]): Promise<unknown> =>
    createLinkMock(...args),
  setSharedContainerLink: (...args: unknown[]): Promise<unknown> =>
    setLinkMock(...args),
  resetSharedContainerLink: (...args: unknown[]): Promise<unknown> =>
    resetLinkMock(...args),
  resolveSharedContainerLink: (...args: unknown[]): Promise<unknown> =>
    resolveLinkMock(...args),
  claimSharedContainerLink: (...args: unknown[]): Promise<unknown> =>
    claimLinkMock(...args),
  listDismissedSharedContainers: (...args: unknown[]): Promise<unknown> =>
    listDismissedMock(...args),
  restoreSharedContainer: (...args: unknown[]): Promise<unknown> =>
    restoreMock(...args),
}));
jest.mock('../shared-containers/file-scope-store', () => ({
  MAX_SHARED_CONTAINER_APPROVED_FILE_PATHS: 200,
  MAX_SHARED_CONTAINER_SELECTED_ITEM_IDS: 1000,
  normalizeSharedContainerFileScope: (value: {
    includedPaths?: string[];
    excludedPaths?: string[];
    legacyAllowlist?: boolean;
    includedNoteIds?: string[];
    excludedNoteIds?: string[];
    includedPromptIds?: string[];
    excludedPromptIds?: string[];
    runSharingEnabled?: boolean;
    runSharingDisabled?: boolean;
    includedRunScripts?: string[];
    excludedRunScripts?: string[];
  }): {
    includedPaths: string[];
    excludedPaths?: string[];
    legacyAllowlist?: boolean;
    includedNoteIds: string[];
    excludedNoteIds: string[];
    includedPromptIds: string[];
    excludedPromptIds: string[];
    runSharingEnabled: boolean;
    runSharingDisabled: boolean;
    includedRunScripts: string[];
    excludedRunScripts: string[];
  } => {
    const normalize = (paths: string[]): string[] =>
      paths
        .map((path) => path.trim().split('\\').join('/'))
        .filter(
          (path) =>
            path.length > 0 &&
            path !== '..' &&
            !path.startsWith('../') &&
            !path.startsWith('/'),
        );
    return {
      includedPaths: normalize(value.includedPaths ?? []),
      ...(value.excludedPaths !== undefined
        ? { excludedPaths: normalize(value.excludedPaths) }
        : {}),
      ...(value.legacyAllowlist === true ? { legacyAllowlist: true } : {}),
      includedNoteIds: value.includedNoteIds ?? [],
      excludedNoteIds: value.excludedNoteIds ?? [],
      includedPromptIds: value.includedPromptIds ?? [],
      excludedPromptIds: value.excludedPromptIds ?? [],
      runSharingEnabled: value.runSharingEnabled === true,
      runSharingDisabled: value.runSharingDisabled === true,
      includedRunScripts: value.includedRunScripts ?? [],
      excludedRunScripts: value.excludedRunScripts ?? [],
    };
  },
  writeSharedContainerFileScope: (...args: unknown[]): Promise<void> =>
    writeFileScopeMock(...args),
  readSharedContainerFileScope: (...args: unknown[]): Promise<unknown> =>
    readFileScopeMock(...args),
  pinSharedContainerPreferredLayout: (...args: unknown[]): Promise<boolean> =>
    pinPreferredLayoutMock(...args),
  pinSharedContainerPreferredLayoutIfMissing: (
    ...args: unknown[]
  ): Promise<boolean> => pinPreferredLayoutIfMissingMock(...args),
}));
const recipientOpenMock = jest.fn<Promise<unknown>, unknown[]>();
const recipientStateMock = jest.fn<Promise<unknown>, unknown[]>();
const recipientDismissMock = jest.fn<Promise<void>, unknown[]>();
const recipientCloseMock = jest.fn<Promise<void>, unknown[]>();
const beginViewerSessionMock = jest.fn<void, unknown[]>();
const isViewerSessionSupersededMock = jest.fn<boolean, unknown[]>();
const listReplicaChatsMock = jest.fn<Promise<unknown>, unknown[]>();
const readReplicaNoteMock = jest.fn<Promise<string>, unknown[]>();
const listReplicaRepositoriesMock = jest.fn<Promise<unknown>, unknown[]>();
const readReplicaRevisionMetadataMock = jest.fn<Promise<unknown>, unknown[]>();
const readRunConfigMock = jest.fn<Promise<unknown>, unknown[]>();
const readerStoreGetMock = jest.fn<Promise<unknown>, unknown[]>();
jest.mock('../shared-containers/read/reader', () => ({
  getSharedContainerReader: (): {
    store: { get: (...args: unknown[]) => Promise<unknown> };
    readRevisionMetadata: (...args: unknown[]) => Promise<unknown>;
    readRunConfig: (...args: unknown[]) => Promise<unknown>;
    listChats: (...args: unknown[]) => Promise<unknown>;
    readNote: (...args: unknown[]) => Promise<string>;
    listRepositories: (...args: unknown[]) => Promise<unknown>;
  } => ({
    store: { get: (...args: unknown[]) => readerStoreGetMock(...args) },
    readRevisionMetadata: (...args: unknown[]): Promise<unknown> =>
      readReplicaRevisionMetadataMock(...args),
    readRunConfig: (...args: unknown[]): Promise<unknown> =>
      readRunConfigMock(...args),
    listChats: (...args: unknown[]): Promise<unknown> =>
      listReplicaChatsMock(...args),
    readNote: (...args: unknown[]): Promise<string> =>
      readReplicaNoteMock(...args),
    listRepositories: (...args: unknown[]): Promise<unknown> =>
      listReplicaRepositoriesMock(...args),
  }),
}));
let replicaChangedCallback: ((state: unknown) => void) | undefined;
let syncPhaseCallback: ((event: unknown) => void) | undefined;
jest.mock('../shared-containers/reconciliation-service', () => ({
  getSharedContainerReconciliationService: (): {
    listSharedWithMe: (...args: unknown[]) => Promise<unknown>;
    open: (...args: unknown[]) => Promise<unknown>;
    getState: (...args: unknown[]) => Promise<unknown>;
    dismiss: (...args: unknown[]) => Promise<void>;
    close: (...args: unknown[]) => Promise<void>;
    beginViewerSession: (...args: unknown[]) => void;
    isViewerSessionSuperseded: (...args: unknown[]) => boolean;
    onChanged: (callback: (state: unknown) => void) => () => void;
    onSyncPhase: (callback: (event: unknown) => void) => () => void;
  } => ({
    listSharedWithMe: (...args: unknown[]): Promise<unknown> =>
      listWithMeMock(...args),
    open: (...args: unknown[]): Promise<unknown> => recipientOpenMock(...args),
    getState: (...args: unknown[]): Promise<unknown> =>
      recipientStateMock(...args),
    dismiss: (...args: unknown[]): Promise<void> =>
      recipientDismissMock(...args),
    close: (...args: unknown[]): Promise<void> => recipientCloseMock(...args),
    beginViewerSession: (...args: unknown[]): void =>
      beginViewerSessionMock(...args),
    isViewerSessionSuperseded: (...args: unknown[]): boolean =>
      isViewerSessionSupersededMock(...args),
    onChanged: (callback: (state: unknown) => void): (() => void) => {
      replicaChangedCallback = callback;
      return () => undefined;
    },
    onSyncPhase: (callback: (event: unknown) => void): (() => void) => {
      syncPhaseCallback = callback;
      return () => undefined;
    },
  }),
}));
const recordAppDiagnosticMock = jest.fn<void, unknown[]>();
const recordSessionDiagnosticMock = jest.fn<void, unknown[]>();
jest.mock('../observability', () => ({
  getObservabilityService: (): {
    recordAppDiagnostic: typeof recordAppDiagnosticMock;
    recordSessionDiagnostic: typeof recordSessionDiagnosticMock;
  } => ({
    recordAppDiagnostic: recordAppDiagnosticMock,
    recordSessionDiagnostic: recordSessionDiagnosticMock,
  }),
}));
const acceptedContainerIds = new Set<string>();
const acceptedContainerIdentities = new Map<
  string,
  SharedContainerAcceptedIdentity
>();
const runAllowedContainerIds = new Set<string>();
const acceptSharedContainerMock = jest.fn(
  (
    containerId: string,
    organizationId?: string,
    _now?: () => Date,
    access?: 'organization' | 'direct',
  ): Promise<SharedContainerAcceptedIdentity> => {
    acceptedContainerIds.add(containerId);
    // Written once, like the real store: a repeat accept keeps the record.
    const kept = acceptedContainerIdentities.get(containerId) ?? {
      ...(organizationId !== undefined ? { organizationId } : {}),
      ...(access !== undefined ? { access } : {}),
    };
    acceptedContainerIdentities.set(containerId, kept);
    return Promise.resolve(kept);
  },
);
jest.mock('../shared-containers/acceptance-store', () => {
  const actual = jest.requireActual<typeof AcceptanceStore>(
    '../shared-containers/acceptance-store',
  );
  return {
    ...actual,
    listAcceptedSharedContainers: (): Promise<
      Record<string, SharedContainerAcceptedIdentity>
    > =>
      Promise.resolve(
        Object.fromEntries(
          Array.from(acceptedContainerIds, (containerId) => [
            containerId,
            acceptedContainerIdentities.get(containerId) ?? {},
          ]),
        ),
      ),
    isSharedContainerAccepted: (containerId: string): Promise<boolean> =>
      Promise.resolve(acceptedContainerIds.has(containerId)),
    isSharedContainerRunAllowed: (containerId: string): Promise<boolean> =>
      Promise.resolve(runAllowedContainerIds.has(containerId)),
    getSharedContainerAcceptance: (containerId: string): Promise<unknown> =>
      Promise.resolve(
        acceptedContainerIds.has(containerId)
          ? {
              organizationId: 'org-1',
              acceptedAt: '2026-01-01T00:00:00.000Z',
              ...(runAllowedContainerIds.has(containerId)
                ? {
                    runAllowedAt: '2026-01-02T00:00:00.000Z',
                    runAllowedPublisherUserId: 'publisher-1',
                  }
                : {}),
            }
          : null,
      ),
    acceptSharedContainer: (
      ...args: [string, string?, (() => Date)?, ('organization' | 'direct')?]
    ): Promise<SharedContainerAcceptedIdentity> =>
      acceptSharedContainerMock(...args),
    allowSharedContainerRun: (containerId: string): Promise<void> => {
      runAllowedContainerIds.add(containerId);
      return Promise.resolve();
    },
    revokeSharedContainerRun: (containerId: string): Promise<void> => {
      runAllowedContainerIds.delete(containerId);
      return Promise.resolve();
    },
    forgetSharedContainerAcceptance: (containerId: string): Promise<void> => {
      acceptedContainerIds.delete(containerId);
      acceptedContainerIdentities.delete(containerId);
      return Promise.resolve();
    },
  };
});
const readRunEnvironmentMock = jest.fn<
  ReturnType<typeof RunEnvironmentStore.readSharedContainerRunEnvironment>,
  Parameters<typeof RunEnvironmentStore.readSharedContainerRunEnvironment>
>(() => Promise.resolve([]));
const writeRunEnvironmentMock = jest.fn<
  ReturnType<typeof RunEnvironmentStore.writeSharedContainerRunEnvironment>,
  Parameters<typeof RunEnvironmentStore.writeSharedContainerRunEnvironment>
>((containerId, values) => {
  void containerId;
  return Promise.resolve(values);
});
const removeRunEnvironmentMock = jest.fn<
  ReturnType<typeof RunEnvironmentStore.removeSharedContainerRunEnvironment>,
  Parameters<typeof RunEnvironmentStore.removeSharedContainerRunEnvironment>
>(() => Promise.resolve());
jest.mock('../shared-containers/run-env-store', () => ({
  projectSharedContainerRunEnvironment: jest.requireActual<
    typeof RunEnvironmentStore
  >('../shared-containers/run-env-store').projectSharedContainerRunEnvironment,
  readSharedContainerRunEnvironment: (
    ...args: Parameters<
      typeof RunEnvironmentStore.readSharedContainerRunEnvironment
    >
  ): ReturnType<typeof RunEnvironmentStore.readSharedContainerRunEnvironment> =>
    readRunEnvironmentMock(...args),
  writeSharedContainerRunEnvironment: (
    ...args: Parameters<
      typeof RunEnvironmentStore.writeSharedContainerRunEnvironment
    >
  ): ReturnType<
    typeof RunEnvironmentStore.writeSharedContainerRunEnvironment
  > => writeRunEnvironmentMock(...args),
  removeSharedContainerRunEnvironment: (
    ...args: Parameters<
      typeof RunEnvironmentStore.removeSharedContainerRunEnvironment
    >
  ): ReturnType<
    typeof RunEnvironmentStore.removeSharedContainerRunEnvironment
  > => removeRunEnvironmentMock(...args),
}));
const refreshRunCopyMock = jest.fn<
  ReturnType<typeof RunCopy.refreshSharedContainerRunCopy>,
  Parameters<typeof RunCopy.refreshSharedContainerRunCopy>
>(() => Promise.resolve('/run'));
const measureRunCopyMock = jest.fn<
  ReturnType<typeof RunCopy.measureSharedContainerRunCopyBytes>,
  Parameters<typeof RunCopy.measureSharedContainerRunCopyBytes>
>(() => Promise.resolve(BigInt(0)));
const runCopyStateMock = jest.fn<
  ReturnType<typeof RunCopy.getSharedContainerRunCopyState>,
  Parameters<typeof RunCopy.getSharedContainerRunCopyState>
>(() => Promise.resolve({ state: 'missing' }));
jest.mock('../shared-containers/run/run-copy', () => ({
  refreshSharedContainerRunCopy: (
    ...args: Parameters<typeof RunCopy.refreshSharedContainerRunCopy>
  ): ReturnType<typeof RunCopy.refreshSharedContainerRunCopy> =>
    refreshRunCopyMock(...args),
  measureSharedContainerRunCopyBytes: (
    ...args: Parameters<typeof RunCopy.measureSharedContainerRunCopyBytes>
  ): ReturnType<typeof RunCopy.measureSharedContainerRunCopyBytes> =>
    measureRunCopyMock(...args),
  getSharedContainerRunCopyState: (
    ...args: Parameters<typeof RunCopy.getSharedContainerRunCopyState>
  ): ReturnType<typeof RunCopy.getSharedContainerRunCopyState> =>
    runCopyStateMock(...args),
}));
const stopWorktreeScriptsMock = jest.fn<
  ReturnType<typeof ScriptsService.stopWorktreeScripts>,
  Parameters<typeof ScriptsService.stopWorktreeScripts>
>(() => Promise.resolve());
jest.mock('../services/scripts-service', () => ({
  stopWorktreeScripts: (
    ...args: Parameters<typeof ScriptsService.stopWorktreeScripts>
  ): ReturnType<typeof ScriptsService.stopWorktreeScripts> =>
    stopWorktreeScriptsMock(...args),
}));
const hasWorktreeTerminalsMock = jest.fn<
  ReturnType<typeof WorkerTerminal.workerTerminal.hasLiveTerminals>,
  Parameters<typeof WorkerTerminal.workerTerminal.hasLiveTerminals>
>(() => false);
const killWorktreeTerminalsMock = jest.fn<
  ReturnType<typeof WorkerTerminal.workerTerminal.killWorktree>,
  Parameters<typeof WorkerTerminal.workerTerminal.killWorktree>
>();
jest.mock('../terminal/worker-terminal', () => ({
  workerTerminal: {
    hasLiveTerminals: (
      ...args: Parameters<typeof WorkerTerminal.workerTerminal.hasLiveTerminals>
    ): ReturnType<typeof WorkerTerminal.workerTerminal.hasLiveTerminals> =>
      hasWorktreeTerminalsMock(...args),
    killWorktree: (
      ...args: Parameters<typeof WorkerTerminal.workerTerminal.killWorktree>
    ): ReturnType<typeof WorkerTerminal.workerTerminal.killWorktree> => {
      killWorktreeTerminalsMock(...args);
    },
  },
}));
const trackedRunScriptsMock = jest.fn<
  ReturnType<typeof ScriptRunner.listTrackedShellScriptsForWorktree>,
  Parameters<typeof ScriptRunner.listTrackedShellScriptsForWorktree>
>(() => []);
jest.mock('../lib/script-runner', () => ({
  listTrackedShellScriptsForWorktree: (
    ...args: Parameters<typeof ScriptRunner.listTrackedShellScriptsForWorktree>
  ): ReturnType<typeof ScriptRunner.listTrackedShellScriptsForWorktree> =>
    trackedRunScriptsMock(...args),
}));
const markNotPublishedMock = jest.fn<unknown, unknown[]>();
const rehydratePublicationStateMock = jest.fn<
  Promise<PublicationState.SharedContainerPublicationRecord[]>,
  []
>(() => Promise.resolve([]));
jest.mock('../shared-containers/publication-state', () => ({
  getSharedContainerPublicationStateStore: (): {
    markNotPublished: typeof markNotPublishedMock;
    rehydrateAll: typeof rehydratePublicationStateMock;
  } => ({
    markNotPublished: markNotPublishedMock,
    rehydrateAll: rehydratePublicationStateMock,
  }),
}));
const recoverPublicationMock = jest.fn(() => Promise.resolve());
const scheduleKnownPublicationMock = jest.fn(() => Promise.resolve());
const schedulePublicationMock = jest.fn();
jest.mock('../shared-containers/publish/scheduler', () => ({
  getSharedContainerPublishScheduler: (): {
    recover: typeof recoverPublicationMock;
    scheduleKnown: typeof scheduleKnownPublicationMock;
    schedule: typeof schedulePublicationMock;
  } => ({
    recover: recoverPublicationMock,
    scheduleKnown: scheduleKnownPublicationMock,
    schedule: schedulePublicationMock,
  }),
}));
const reserveSharedContainerAnchorMock = jest.fn<Promise<boolean>, unknown[]>();
const releaseSharedContainerAnchorMock = jest.fn<Promise<void>, unknown[]>();
const resolveServerWorktreeExternalIdMock = jest.fn<string | null, unknown[]>();
const buildLocalWorktreeIndexByServerExternalIdMock = jest.fn<
  ReadonlyMap<string, { projectId: string; worktreeId: string }>,
  unknown[]
>();
jest.mock('../services/telemetry-sync-service', () => ({
  getTelemetrySyncService: (): {
    reserveSharedContainerAnchor: typeof reserveSharedContainerAnchorMock;
    releaseSharedContainerAnchor: typeof releaseSharedContainerAnchorMock;
    resolveServerWorktreeExternalId: typeof resolveServerWorktreeExternalIdMock;
    buildLocalWorktreeIndexByServerExternalId: typeof buildLocalWorktreeIndexByServerExternalIdMock;
  } => ({
    reserveSharedContainerAnchor: reserveSharedContainerAnchorMock,
    releaseSharedContainerAnchor: releaseSharedContainerAnchorMock,
    resolveServerWorktreeExternalId: resolveServerWorktreeExternalIdMock,
    buildLocalWorktreeIndexByServerExternalId:
      buildLocalWorktreeIndexByServerExternalIdMock,
  }),
}));
const forkSharedContainerMock = jest.fn<Promise<unknown>, unknown[]>();
jest.mock('../shared-containers/fork', () => ({
  forkSharedContainer: (...args: unknown[]): Promise<unknown> =>
    forkSharedContainerMock(...args),
}));
// CAN-4655: only a fork installs a capability package. Viewing, accepting and
// opening must never reach the installer.
const installForkCapabilityPackageMock = jest.fn<
  Promise<string[]>,
  unknown[]
>();
const recoverForkCapabilityInstallsMock = jest.fn(() => Promise.resolve());
jest.mock('../shared-containers/capability-package/install', () => ({
  installForkCapabilityPackage: (...args: unknown[]): Promise<string[]> =>
    installForkCapabilityPackageMock(...args),
  recoverForkCapabilityInstalls: (): Promise<void> =>
    recoverForkCapabilityInstallsMock(),
}));

import {
  classifySharedContainerError,
  registerSharedContainerHandlers,
} from '../ipc/shared-containers';
import {
  resetSharedContainerListingBlockedDedupe,
  resetSharedContainerListingUnavailableDedupe,
} from '../shared-containers/listing-diagnostics';

import { SharedContainerForkError } from '../shared-containers/fork/destination';
import {
  createWorkspaceMetadataTestDispatcher,
  TEST_IPC_CALLER,
} from './fixtures/workspace-metadata-dispatcher';

// The fork channel projects its registered operation (W7b-4).
const TEST_RUNTIME = {
  dispatcher: createWorkspaceMetadataTestDispatcher(),
  resolveCaller: (): typeof TEST_IPC_CALLER => TEST_IPC_CALLER,
};

describe('shared-container IPC handlers', () => {
  const originalPlatformDescriptor = Object.getOwnPropertyDescriptor(
    process,
    'platform',
  );

  beforeAll(() => {
    Object.defineProperty(process, 'platform', {
      configurable: true,
      value: 'darwin',
    });
  });

  afterAll(() => {
    if (originalPlatformDescriptor) {
      Object.defineProperty(process, 'platform', originalPlatformDescriptor);
    }
  });

  beforeEach(() => {
    jest.clearAllMocks();
    isFeatureEnabledMock.mockReturnValue(true);
    isCoworkWorkspaceMock.mockReturnValue(false);
    writeFileScopeMock.mockResolvedValue(undefined);
    pinPreferredLayoutMock.mockResolvedValue(true);
    pinPreferredLayoutIfMissingMock.mockResolvedValue(true);
    untrackedCandidatesMock.mockResolvedValue(['src/a.ts']);
    reserveSharedContainerAnchorMock.mockResolvedValue(true);
    releaseSharedContainerAnchorMock.mockResolvedValue(undefined);
    resolveServerWorktreeExternalIdMock.mockReturnValue('server-worktree-1');
    buildLocalWorktreeIndexByServerExternalIdMock.mockReturnValue(new Map());
    handlers.clear();
    acceptedContainerIds.clear();
    acceptedContainerIdentities.clear();
    runAllowedContainerIds.clear();
    readRunConfigMock.mockResolvedValue({
      commands: [{ name: 'launch', command: 'echo started', repoId: 'repo-1' }],
      requiredEnv: ['DATABASE_URL'],
    });
    readerStoreGetMock.mockResolvedValue({
      status: 'available',
      revisionId: 'revision-1',
    });
    recipientStateMock.mockResolvedValue({
      status: 'available',
      revisionId: 'revision-1',
    });
    isViewerSessionSupersededMock.mockReturnValue(false);
    // Module state: without this, the first spec to record a billing-block
    // diagnostic would suppress every later spec's within the dedupe window.
    resetSharedContainerListingBlockedDedupe();
    resetSharedContainerListingUnavailableDedupe();
    trackedPlansWriteListener = undefined;
    registerSharedContainerHandlers(TEST_RUNTIME);
  });

  it('resolves and claims capability links, recording claim as device consent', async () => {
    const token = 'A'.repeat(43);
    resolveLinkMock.mockResolvedValue({ state: 'ready' });
    claimLinkMock.mockResolvedValue({
      id: 'container-1',
      organizationId: 'org-1',
      access: 'organization',
    });

    await expect(
      handlers.get(IPC_CHANNELS.sharedContainersResolveLink)?.({}, { token }),
    ).resolves.toEqual({ state: 'ready' });
    await expect(
      handlers.get(IPC_CHANNELS.sharedContainersClaimLink)?.({}, { token }),
    ).resolves.toMatchObject({ id: 'container-1' });

    expect(acceptSharedContainerMock).toHaveBeenCalledWith(
      'container-1',
      'org-1',
      undefined,
      'organization',
    );
  });

  it('gets, changes, resets, and removes an owner capability link', async () => {
    getLinkMock.mockResolvedValue(null);
    setLinkMock.mockResolvedValue({ audience: 'ANYONE', url: '/share/view/x' });
    resetLinkMock.mockResolvedValue({
      audience: 'ANYONE',
      url: '/share/view/y',
    });

    await handlers.get(IPC_CHANNELS.sharedContainersGetLink)?.(
      {},
      { containerId: 'container-1' },
    );
    await handlers.get(IPC_CHANNELS.sharedContainersSetLink)?.(
      {},
      { containerId: 'container-1', audience: 'ANYONE' },
    );
    await handlers.get(IPC_CHANNELS.sharedContainersResetLink)?.(
      {},
      { containerId: 'container-1' },
    );
    await handlers.get(IPC_CHANNELS.sharedContainersSetLink)?.(
      {},
      { containerId: 'container-1', audience: null },
    );

    expect(getLinkMock).toHaveBeenCalledWith('container-1');
    expect(setLinkMock).toHaveBeenNthCalledWith(1, 'container-1', 'ANYONE');
    expect(setLinkMock).toHaveBeenNthCalledWith(2, 'container-1', null);
    expect(resetLinkMock).toHaveBeenCalledWith('container-1');
  });

  it('reserves an anchor, creates the first link, and schedules publication without an invite', async () => {
    eligibilityMock.mockResolvedValue({
      eligible: true,
      serverWorktreeExternalId: 'server-worktree-1',
      ownerOrganizationId: 'org-1',
      link: { anyone: true, organization: true },
    });
    createLinkMock.mockResolvedValue({
      container: {
        id: 'container-1',
        revision: 0,
        containerType: 'CODE_WORKTREE',
      },
      link: { audience: 'ANYONE', url: '/share/view/link' },
    });

    await expect(
      handlers.get(IPC_CHANNELS.sharedContainersSetLink)?.(
        {},
        {
          projectId: 'project-1',
          worktreeId: 'worktree-1',
          containerType: 'CODE_WORKTREE',
          organizationId: 'org-1',
          containerId: null,
          audience: 'ANYONE',
        },
      ),
    ).resolves.toMatchObject({
      container: { id: 'container-1' },
      link: { audience: 'ANYONE' },
    });
    expect(reserveSharedContainerAnchorMock).toHaveBeenCalledWith(
      'project-1',
      'worktree-1',
      'org-1',
      'server-worktree-1',
    );
    expect(createLinkMock).toHaveBeenCalledWith({
      worktreeId: 'server-worktree-1',
      organizationId: 'org-1',
      audience: 'ANYONE',
    });
    expect(markNotPublishedMock).toHaveBeenCalledWith(
      expect.objectContaining({ containerId: 'container-1' }),
    );
    expect(schedulePublicationMock).toHaveBeenCalledWith(
      expect.objectContaining({ containerId: 'container-1' }),
      true,
    );
    // The first revision must carry the layout pinned at share time.
    expect(pinPreferredLayoutIfMissingMock).toHaveBeenCalledWith(
      'project-1',
      'worktree-1',
    );
    expect(
      pinPreferredLayoutIfMissingMock.mock.invocationCallOrder[0],
    ).toBeLessThan(schedulePublicationMock.mock.invocationCallOrder[0] ?? 0);
  });

  it('still schedules the first publication when the preferred layout pin fails', async () => {
    eligibilityMock.mockResolvedValue({
      eligible: true,
      serverWorktreeExternalId: 'server-worktree-1',
      ownerOrganizationId: 'org-1',
      link: { anyone: true, organization: true },
    });
    createLinkMock.mockResolvedValue({
      container: {
        id: 'container-1',
        revision: 0,
        containerType: 'CODE_WORKTREE',
      },
      link: { audience: 'ANYONE', url: '/share/view/link' },
    });
    pinPreferredLayoutIfMissingMock.mockRejectedValue(new Error('disk full'));

    await expect(
      handlers.get(IPC_CHANNELS.sharedContainersSetLink)?.(
        {},
        {
          projectId: 'project-1',
          worktreeId: 'worktree-1',
          containerType: 'CODE_WORKTREE',
          organizationId: 'org-1',
          containerId: null,
          audience: 'ANYONE',
        },
      ),
    ).resolves.toMatchObject({ container: { id: 'container-1' } });
    expect(schedulePublicationMock).toHaveBeenCalledWith(
      expect.objectContaining({ containerId: 'container-1' }),
      true,
    );
  });

  it('schedules a plan-only persistence write for another publication', async () => {
    expect(addTrackedPlansWriteListenerMock).toHaveBeenCalledTimes(1);

    trackedPlansWriteListener?.('project-1', 'worktree-1', {
      version: 1,
      plans: [],
    });
    await Promise.resolve();

    expect(scheduleKnownPublicationMock).toHaveBeenCalledWith(
      'project-1',
      'worktree-1',
    );
  });

  it('hands recoverable persisted publications to the scheduler after rehydration', async () => {
    await Promise.resolve();
    recoverPublicationMock.mockClear();
    const restored: PublicationState.SharedContainerPublicationRecord[] = [
      {
        projectId: 'project-1',
        worktreeId: 'worktree-1',
        organizationId: 'org-1',
        containerId: 'container-1',
        containerType: 'COWORK_WORK_ENTRY',
        status: 'publishing',
        idempotencyKey: 'same-key',
        stagingSessionId: 'same-stage',
        updatedAt: 'now',
      },
    ];
    rehydratePublicationStateMock.mockResolvedValueOnce(restored);

    registerSharedContainerHandlers(TEST_RUNTIME);
    await Promise.resolve();
    await Promise.resolve();

    expect(recoverPublicationMock).toHaveBeenCalledWith(restored);
  });

  it('finishes or undoes interrupted fork capability installs at startup', async () => {
    recoverForkCapabilityInstallsMock.mockClear();

    registerSharedContainerHandlers(TEST_RUNTIME);

    for (
      let attempt = 0;
      attempt < 50 && recoverForkCapabilityInstallsMock.mock.calls.length === 0;
      attempt += 1
    ) {
      await new Promise((resolve) => setImmediate(resolve));
    }
    expect(recoverForkCapabilityInstallsMock).toHaveBeenCalledTimes(1);
  });

  it('records a worktree-scoped diagnostic when share preview fails', async () => {
    isCoworkWorkspaceMock.mockReturnValue(true);
    previewMock.mockRejectedValueOnce(new Error('preview exploded'));
    const request = {
      projectId: 'project-1',
      worktreeId: 'worktree-1',
      organizationId: 'org-1',
      containerType: 'COWORK_WORK_ENTRY',
    };

    await expect(
      handlers.get(IPC_CHANNELS.sharedContainersPreview)?.({}, request),
    ).rejects.toThrow('preview exploded');
    expect(recordSessionDiagnosticMock).toHaveBeenCalledWith(
      expect.objectContaining({
        kind: 'shared_container_preview_failure',
        sessionKey: 'project-1/worktree-1/org-1',
        projectId: 'project-1',
        worktreeId: 'worktree-1',
        sharedContainerOrganizationId: 'org-1',
        sharedContainerType: 'COWORK_WORK_ENTRY',
        error: 'preview exploded',
      }),
    );
  });

  it('refuses to open or retry a container this device has not accepted', async () => {
    await expect(
      handlers.get(IPC_CHANNELS.sharedContainersOpen)?.(
        {},
        { containerId: 'container-1', organizationId: 'org-1' },
      ),
    ).rejects.toThrow('has not been accepted');
    await expect(
      handlers.get(IPC_CHANNELS.sharedContainersRetry)?.(
        {},
        { containerId: 'container-1', organizationId: 'org-1' },
      ),
    ).rejects.toThrow('has not been accepted');
    // Nothing reached the reconciliation service, so nothing was cloned.
    expect(recipientOpenMock).not.toHaveBeenCalled();
  });

  it.each([
    ['open', IPC_CHANNELS.sharedContainersOpen],
    ['retry', IPC_CHANNELS.sharedContainersRetry],
  ])(
    'does not resolve %s before the reconciliation open has projected',
    async (_name, channel) => {
      await handlers.get(IPC_CHANNELS.sharedContainersAccept)?.(
        {},
        { containerId: 'container-1', organizationId: 'org-1' },
      );
      // The reconciliation open resolves only after the viewer layout reset
      // has committed, so the renderer must not hear back before it does.
      let finishOpen: (state: unknown) => void = () => undefined;
      recipientOpenMock.mockReturnValue(
        new Promise((resolve) => {
          finishOpen = resolve;
        }),
      );
      let settled = false;
      const opened = Promise.resolve(
        handlers.get(channel)?.(
          {},
          { containerId: 'container-1', organizationId: 'org-1' },
        ),
      ).then((state) => {
        settled = true;
        return state;
      });
      for (let turn = 0; turn < 20; turn += 1) await Promise.resolve();
      await new Promise((resolve) => setImmediate(resolve));

      expect(recipientOpenMock).toHaveBeenCalled();
      expect(settled).toBe(false);

      const state = { status: 'nothing-published', containerId: 'container-1' };
      finishOpen(state);
      await expect(opened).resolves.toEqual(state);
    },
  );

  it('opens only after the recipient accepts, and lists what was accepted', async () => {
    const state = { status: 'nothing-published', containerId: 'container-1' };
    recipientOpenMock.mockResolvedValue(state);

    await expect(
      handlers.get(IPC_CHANNELS.sharedContainersListAccepted)?.({}, undefined),
    ).resolves.toEqual({ containerIds: [], records: {} });

    await expect(
      handlers.get(IPC_CHANNELS.sharedContainersAccept)?.(
        {},
        { containerId: 'container-1', organizationId: 'org-1' },
      ),
    ).resolves.toEqual({
      accepted: true,
      record: { organizationId: 'org-1' },
    });

    await expect(
      handlers.get(IPC_CHANNELS.sharedContainersListAccepted)?.({}, undefined),
    ).resolves.toEqual({
      containerIds: ['container-1'],
      records: { 'container-1': { organizationId: 'org-1' } },
    });
    await expect(
      handlers.get(IPC_CHANNELS.sharedContainersOpen)?.(
        {},
        { containerId: 'container-1', organizationId: 'org-1' },
      ),
    ).resolves.toEqual(state);
    expect(recipientOpenMock).toHaveBeenCalledWith(
      'container-1',
      'org-1',
      false,
      undefined,
    );
    expect(installForkCapabilityPackageMock).not.toHaveBeenCalled();
  });

  // A viewer close can land after a later open of the same share. Open, retry
  // and close therefore carry the renderer's viewer session, and a close only
  // acts when its session is still the newest one main has seen.
  describe('viewer sessions', () => {
    const state = { status: 'nothing-published', containerId: 'container-1' };

    beforeEach(() => {
      recipientOpenMock.mockResolvedValue(state);
      recipientCloseMock.mockResolvedValue(undefined);
    });

    it('forwards the viewer session on open, retry and close', async () => {
      acceptedContainerIds.add('container-1');

      await handlers.get(IPC_CHANNELS.sharedContainersOpen)?.(
        {},
        {
          containerId: 'container-1',
          organizationId: 'org-1',
          viewerSessionId: 'session-1',
        },
      );
      expect(beginViewerSessionMock).toHaveBeenLastCalledWith(
        'container-1',
        'session-1',
      );
      expect(recipientOpenMock).toHaveBeenLastCalledWith(
        'container-1',
        'org-1',
        false,
        undefined,
        'session-1',
      );

      await handlers.get(IPC_CHANNELS.sharedContainersRetry)?.(
        {},
        {
          containerId: 'container-1',
          organizationId: 'org-1',
          access: 'direct',
          viewerSessionId: 'session-1',
        },
      );
      expect(beginViewerSessionMock).toHaveBeenCalledTimes(2);
      expect(beginViewerSessionMock).toHaveBeenLastCalledWith(
        'container-1',
        'session-1',
      );
      expect(recipientOpenMock).toHaveBeenLastCalledWith(
        'container-1',
        'org-1',
        true,
        'direct',
        'session-1',
      );

      await handlers.get(IPC_CHANNELS.sharedContainersClose)?.(
        {},
        { containerId: 'container-1', viewerSessionId: 'session-1' },
      );
      expect(isViewerSessionSupersededMock).toHaveBeenCalledWith(
        'container-1',
        'session-1',
      );
      expect(recipientCloseMock).toHaveBeenCalledWith(
        'container-1',
        'session-1',
      );
    });

    it.each([
      ['open', IPC_CHANNELS.sharedContainersOpen],
      ['retry', IPC_CHANNELS.sharedContainersRetry],
    ])(
      'registers the viewer session before the acceptance check on %s',
      async (_name, channel) => {
        // Not accepted, so the handler rejects at its first await. The session
        // must already be registered by then: sessions are ordered by IPC
        // arrival, and registering after an await would reopen the race.
        const pending = handlers.get(channel)?.(
          {},
          {
            containerId: 'container-1',
            organizationId: 'org-1',
            viewerSessionId: 'session-1',
          },
        );
        // Attached before the synchronous assertion so the rejection always
        // has a handler, even when that assertion fails.
        const rejected = expect(pending).rejects.toThrow(
          'has not been accepted',
        );

        expect(beginViewerSessionMock).toHaveBeenCalledWith(
          'container-1',
          'session-1',
        );
        await rejected;
        expect(recipientOpenMock).not.toHaveBeenCalled();
      },
    );

    it.each([
      ['open', IPC_CHANNELS.sharedContainersOpen],
      ['retry', IPC_CHANNELS.sharedContainersRetry],
      ['close', IPC_CHANNELS.sharedContainersClose],
    ])(
      'rejects a malformed viewer session id on %s',
      async (_name, channel) => {
        acceptedContainerIds.add('container-1');

        for (const viewerSessionId of [
          '',
          'Session_1',
          '../session',
          42,
          null,
          'a'.repeat(65),
        ]) {
          await expect(
            handlers.get(channel)?.(
              {},
              { containerId: 'container-1', viewerSessionId },
            ),
          ).rejects.toThrow('Invalid viewerSessionId');
        }

        expect(beginViewerSessionMock).not.toHaveBeenCalled();
        expect(recipientOpenMock).not.toHaveBeenCalled();
        expect(recipientCloseMock).not.toHaveBeenCalled();
        expect(killWorktreeTerminalsMock).not.toHaveBeenCalled();
        expect(stopWorktreeScriptsMock).not.toHaveBeenCalled();
      },
    );

    it('accepts a viewer session id at the length limit', async () => {
      acceptedContainerIds.add('container-1');
      const viewerSessionId = 'a'.repeat(64);

      await handlers.get(IPC_CHANNELS.sharedContainersOpen)?.(
        {},
        { containerId: 'container-1', viewerSessionId },
      );

      expect(beginViewerSessionMock).toHaveBeenCalledWith(
        'container-1',
        viewerSessionId,
      );
    });

    it('does not stop processes for a superseded close', async () => {
      isViewerSessionSupersededMock.mockReturnValue(true);

      await handlers.get(IPC_CHANNELS.sharedContainersClose)?.(
        {},
        { containerId: 'container-1', viewerSessionId: 'session-1' },
      );

      // The terminals and scripts now belong to the session on screen.
      expect(killWorktreeTerminalsMock).not.toHaveBeenCalled();
      expect(stopWorktreeScriptsMock).not.toHaveBeenCalled();
      // The service still sees the close: it re-checks supersession itself
      // and owns the diagnostic.
      expect(recipientCloseMock).toHaveBeenCalledWith(
        'container-1',
        'session-1',
      );
    });

    it('stops processes and closes for the newest viewer session', async () => {
      await handlers.get(IPC_CHANNELS.sharedContainersClose)?.(
        {},
        { containerId: 'container-1', viewerSessionId: 'session-1' },
      );

      expect(killWorktreeTerminalsMock).toHaveBeenCalledWith({
        projectId: 'shared-container-viewer',
        worktreeId: 'container-1',
      });
      expect(stopWorktreeScriptsMock).toHaveBeenCalledWith({
        projectId: 'shared-container-viewer',
        worktreeId: 'container-1',
      });
      expect(recipientCloseMock).toHaveBeenCalledWith(
        'container-1',
        'session-1',
      );
    });

    it('stops processes and closes for a close without a viewer session', async () => {
      // A legacy caller is never treated as superseded, whatever is recorded.
      isViewerSessionSupersededMock.mockReturnValue(true);

      await handlers.get(IPC_CHANNELS.sharedContainersClose)?.(
        {},
        { containerId: 'container-1' },
      );

      expect(isViewerSessionSupersededMock).not.toHaveBeenCalled();
      expect(killWorktreeTerminalsMock).toHaveBeenCalledTimes(1);
      expect(stopWorktreeScriptsMock).toHaveBeenCalledTimes(1);
      expect(recipientCloseMock).toHaveBeenCalledWith('container-1');
    });

    it('omits the viewer session argument when the request has none', async () => {
      acceptedContainerIds.add('container-1');

      await handlers.get(IPC_CHANNELS.sharedContainersOpen)?.(
        {},
        { containerId: 'container-1', organizationId: 'org-1' },
      );
      await handlers.get(IPC_CHANNELS.sharedContainersRetry)?.(
        {},
        { containerId: 'container-1', organizationId: 'org-1' },
      );
      await handlers.get(IPC_CHANNELS.sharedContainersClose)?.(
        {},
        { containerId: 'container-1' },
      );

      expect(beginViewerSessionMock).not.toHaveBeenCalled();
      expect(recipientOpenMock.mock.calls).toEqual([
        ['container-1', 'org-1', false, undefined],
        ['container-1', 'org-1', true, undefined],
      ]);
      expect(recipientCloseMock.mock.calls).toEqual([['container-1']]);
    });
  });

  it('forks only accepted revisions after validating the destination', async () => {
    const request = {
      containerId: 'container-1',
      revisionId: 'revision-1',
      organizationId: 'org-1',
      sourceOwnerDisplayName: '  Ada  ',
      destination: { kind: 'existing-workspace', workspaceId: 'workspace-1' },
    } as const;
    await expect(
      handlers.get(IPC_CHANNELS.sharedContainersFork)?.({}, request),
    ).resolves.toEqual({
      ok: false,
      code: 'source-unavailable',
      message: 'Accept the share before making a copy.',
    });
    expect(forkSharedContainerMock).not.toHaveBeenCalled();

    acceptedContainerIds.add('container-1');
    forkSharedContainerMock.mockResolvedValue({ projectId: 'workspace-1' });
    await expect(
      handlers.get(IPC_CHANNELS.sharedContainersFork)?.({}, request),
    ).resolves.toEqual({ projectId: 'workspace-1' });
    expect(forkSharedContainerMock).toHaveBeenCalledWith({
      ...request,
      sourceOwnerDisplayName: 'Ada',
    });

    await expect(
      handlers.get(IPC_CHANNELS.sharedContainersFork)?.(
        {},
        {
          ...request,
          destination: { kind: 'existing-workspace', workspaceId: '../bad' },
        },
      ),
    ).resolves.toMatchObject({ ok: false, code: 'invalid-destination' });
  });

  it.each([
    { kind: 'new-workspace' },
    { kind: 'new-workspace', owner: null },
    { kind: 'new-workspace', owner: { kind: 'organization' } },
    {
      kind: 'new-workspace',
      owner: { kind: 'organization', organizationId: 'not-a-uuid' },
    },
    {
      kind: 'new-workspace',
      owner: { kind: 'personal', organizationId: 'forged' },
    },
    {
      kind: 'new-workspace',
      owner: { kind: 'personal' },
      parentDirectory: '../relative',
    },
    {
      kind: 'existing-workspace',
      workspaceId: 'workspace-1',
      owner: { kind: 'personal' },
    },
  ])(
    'returns a typed refusal for malformed fork destination %j',
    async (destination) => {
      acceptedContainerIds.add('container-1');
      await expect(
        handlers.get(IPC_CHANNELS.sharedContainersFork)?.(
          {},
          {
            containerId: 'container-1',
            revisionId: 'revision-1',
            sourceOwnerDisplayName: 'Ada',
            destination,
          },
        ),
      ).resolves.toMatchObject({ ok: false, code: 'invalid-destination' });
      expect(forkSharedContainerMock).not.toHaveBeenCalled();
    },
  );

  it('normalizes and forwards an explicit organization owner', async () => {
    acceptedContainerIds.add('container-1');
    const organizationId = '11111111-AAAA-4111-8111-111111111111';
    await handlers.get(IPC_CHANNELS.sharedContainersFork)?.(
      {},
      {
        containerId: 'container-1',
        revisionId: 'revision-1',
        sourceOwnerDisplayName: 'Ada',
        destination: {
          kind: 'new-workspace',
          owner: { kind: 'organization', organizationId },
        },
      },
    );
    expect(forkSharedContainerMock).toHaveBeenCalledWith(
      expect.objectContaining({
        destination: {
          kind: 'new-workspace',
          owner: {
            kind: 'organization',
            organizationId: organizationId.toLowerCase(),
          },
        },
      }),
    );
  });

  it('preserves the anchored revision in the fork IPC result', async () => {
    acceptedContainerIds.add('container-1');
    const result = {
      containerType: 'COWORK_WORK_ENTRY',
      projectId: 'workspace-1',
      worktreeId: 'entry-1',
      warnings: [],
      provenance: {
        sourceContainerId: 'container-1',
        sourceRevisionId: 'revision-2',
        sourceOwnerDisplayName: 'Ada',
        sourceRevisionCreatedAt: '2026-09-02T10:30:00.000Z',
        forkedAt: '2026-10-23T12:00:00.000Z',
      },
    };
    forkSharedContainerMock.mockResolvedValueOnce(result);
    const received = await handlers.get(IPC_CHANNELS.sharedContainersFork)?.(
      {},
      {
        containerId: 'container-1',
        revisionId: 'revision-2',
        sourceOwnerDisplayName: 'Ada',
        destination: { kind: 'new-workspace', owner: { kind: 'personal' } },
      },
    );
    expect(JSON.parse(JSON.stringify(received))).toEqual(result);
  });

  it.each(['source-unavailable', 'organization-creation-unavailable'] as const)(
    'keeps the stable backend refusal code %s in the IPC response',
    async (code) => {
      acceptedContainerIds.add('container-1');
      forkSharedContainerMock.mockRejectedValueOnce(
        new SharedContainerForkError(
          code,
          "You can't create projects in the organization right now, so the copy wasn't made.",
        ),
      );
      await expect(
        handlers.get(IPC_CHANNELS.sharedContainersFork)?.(
          {},
          {
            containerId: 'container-1',
            revisionId: 'revision-1',
            sourceOwnerDisplayName: 'Ada',
            destination: { kind: 'new-workspace', owner: { kind: 'personal' } },
          },
        ),
      ).resolves.toEqual({
        ok: false,
        code,
        message:
          "You can't create projects in the organization right now, so the copy wasn't made.",
      });
    },
  );

  it('forwards only a well-formed disclosed package digest to the fork', async () => {
    acceptedContainerIds.add('container-1');
    forkSharedContainerMock.mockResolvedValue({ projectId: 'workspace-1' });
    const request = {
      containerId: 'container-1',
      revisionId: 'revision-1',
      sourceOwnerDisplayName: 'Ada',
      destination: { kind: 'new-workspace', owner: { kind: 'personal' } },
    } as const;
    await expect(
      handlers.get(IPC_CHANNELS.sharedContainersFork)?.(
        {},
        { ...request, expectedPackageDigest: 'latest' },
      ),
    ).rejects.toThrow('Invalid fork expectedPackageDigest');
    expect(forkSharedContainerMock).not.toHaveBeenCalled();

    const digest = `pp:v1:${'A'.repeat(43)}`;
    await handlers.get(IPC_CHANNELS.sharedContainersFork)?.(
      {},
      { ...request, expectedPackageDigest: digest },
    );
    expect(forkSharedContainerMock).toHaveBeenCalledWith(
      expect.objectContaining({ expectedPackageDigest: digest }),
    );
  });

  it('validates provenance reads before resolving local paths', async () => {
    await expect(
      handlers.get(IPC_CHANNELS.sharedContainersReadForkProvenance)?.(
        {},
        { projectId: '../bad', worktreeId: 'worktree-1' },
      ),
    ).rejects.toThrow('Invalid projectId');
  });

  it('fails every run entry point closed until acceptance and run consent are present', async () => {
    const statusHandler = handlers.get(IPC_CHANNELS.sharedContainersRunStatus);
    const allowHandler = handlers.get(IPC_CHANNELS.sharedContainersAllowRun);
    const refreshHandler = handlers.get(
      IPC_CHANNELS.sharedContainersRefreshRunCopy,
    );

    await expect(
      statusHandler?.(
        {},
        { containerId: 'container-1', revisionId: 'revision-1' },
      ),
    ).rejects.toThrow('has not been accepted');

    acceptedContainerIds.add('container-1');
    await expect(
      refreshHandler?.(
        {},
        { containerId: 'container-1', revisionId: 'revision-1' },
      ),
    ).rejects.toThrow('not allowed');
    expect(refreshRunCopyMock).not.toHaveBeenCalled();

    await allowHandler?.(
      {},
      { containerId: 'container-1', publisherUserId: 'publisher-1' },
    );
    await expect(
      refreshHandler?.(
        {},
        { containerId: 'container-1', revisionId: 'revision-1' },
      ),
    ).resolves.toBeUndefined();
    expect(refreshRunCopyMock).toHaveBeenCalledTimes(1);
  });

  it('refuses a second refresh instead of queuing it behind the first', async () => {
    acceptedContainerIds.add('container-1');
    runAllowedContainerIds.add('container-1');
    let releaseRefresh!: () => void;
    refreshRunCopyMock.mockImplementationOnce(
      () =>
        new Promise<string>((resolve) => {
          releaseRefresh = (): void => resolve('/run');
        }),
    );
    const refreshHandler = handlers.get(
      IPC_CHANNELS.sharedContainersRefreshRunCopy,
    );

    const first = refreshHandler?.(
      {},
      { containerId: 'container-1', revisionId: 'revision-1' },
    );
    while (refreshRunCopyMock.mock.calls.length === 0) await Promise.resolve();
    const second = refreshHandler?.(
      {},
      { containerId: 'container-1', revisionId: 'revision-1' },
    );
    const outcome = await Promise.race([
      Promise.resolve(second).then(
        () => 'resolved',
        (error: unknown) =>
          error instanceof Error ? error.message : String(error),
      ),
      new Promise<string>((resolve) => {
        setTimeout(() => resolve('queued'), 25);
      }),
    ]);
    releaseRefresh();
    await first;

    expect(outcome).toContain('already in progress');
    expect(refreshRunCopyMock).toHaveBeenCalledTimes(1);
  });

  it('returns only current declared env names, never their values, and reports stale/running copy state', async () => {
    acceptedContainerIds.add('container-1');
    runAllowedContainerIds.add('container-1');
    readRunEnvironmentMock.mockResolvedValue([
      { key: 'DATABASE_URL', value: 'postgres://local' },
      { key: 'OLD_NAME', value: 'must-not-return' },
    ]);
    runCopyStateMock.mockResolvedValue({
      state: 'committed',
      revisionId: 'revision-0',
    });
    hasWorktreeTerminalsMock.mockReturnValue(true);

    const status = await handlers.get(IPC_CHANNELS.sharedContainersRunStatus)?.(
      {},
      { containerId: 'container-1', revisionId: 'revision-1' },
    );
    expect(JSON.stringify(status)).not.toContain('postgres://local');
    expect(status).toMatchObject({
      values: [
        {
          key: 'DATABASE_URL',
          value: {
            kind: 'stored-secret',
            ref: storedSecretRef(
              'shared_container.run_env',
              'container-1',
              'DATABASE_URL',
            ),
          },
        },
      ],
      unsetRequiredEnv: [],
      runCopyNeedsRefresh: true,
      hasRunningProcesses: true,
    });
  });

  it('lists the recorded identity of each accepted share, keyed like the ids', async () => {
    await handlers.get(IPC_CHANNELS.sharedContainersAccept)?.(
      {},
      {
        containerId: 'container-1',
        organizationId: 'org-1',
        access: 'organization',
      },
    );
    await handlers.get(IPC_CHANNELS.sharedContainersAccept)?.(
      {},
      { containerId: 'container-2', access: 'direct' },
    );

    await expect(
      handlers.get(IPC_CHANNELS.sharedContainersListAccepted)?.({}, undefined),
    ).resolves.toEqual({
      containerIds: ['container-1', 'container-2'],
      records: {
        'container-1': { organizationId: 'org-1', access: 'organization' },
        'container-2': { access: 'direct' },
      },
    });
  });

  it('answers a repeat accept with the record main kept', async () => {
    await handlers.get(IPC_CHANNELS.sharedContainersAccept)?.(
      {},
      {
        containerId: 'container-1',
        organizationId: 'org-1',
        access: 'organization',
      },
    );

    // The renderer mirrors this answer, so it has to be the stored record and
    // not the identity this round's listing sent.
    await expect(
      handlers.get(IPC_CHANNELS.sharedContainersAccept)?.(
        {},
        { containerId: 'container-1', access: 'direct' },
      ),
    ).resolves.toEqual({
      accepted: true,
      record: { organizationId: 'org-1', access: 'organization' },
    });
  });

  describe('recoverable removal', () => {
    const container = { id: 'container-1', title: 'Feature branch' };
    const unsupported = (): CanopyCloudClientError =>
      new CanopyCloudClientError(
        'unsupported-capability',
        'Cloud does not support shared-container-dismissals-v1.',
      );
    const notRestorable = (): CanopyCloudClientError =>
      new CanopyCloudClientError(
        'http-error',
        'Shared container not found',
        404,
        'shared-container-dismissal-not-found',
      );
    const listDismissed = (request: unknown): unknown =>
      handlers.get(IPC_CHANNELS.sharedContainersListDismissed)?.({}, request);
    const restore = (request: unknown): unknown =>
      handlers.get(IPC_CHANNELS.sharedContainersRestore)?.({}, request);

    beforeEach(() => {
      listDismissedMock.mockReset();
      restoreMock.mockReset();
      signalLocalChangeMock.mockReset();
    });

    it('lists removed shares for the requested scope', async () => {
      const page = {
        containers: [{ ...container, dismissedAt: '2026-10-01T00:00:00.000Z' }],
        nextCursor: 'next',
      };
      listDismissedMock.mockResolvedValue(page);

      await expect(
        listDismissed({ organizationId: 'org-1', cursor: 'abc', limit: 10 }),
      ).resolves.toEqual(page);
      expect(listDismissedMock).toHaveBeenCalledWith({
        organizationId: 'org-1',
        cursor: 'abc',
        limit: 10,
      });

      // No organization lists removed direct shares; nothing is sent empty.
      await listDismissed({});
      expect(listDismissedMock).toHaveBeenLastCalledWith({});
    });

    it('never asks the server for a larger page than its route accepts', async () => {
      listDismissedMock.mockResolvedValue({ containers: [], nextCursor: null });

      await listDismissed({ limit: MAX_SHARED_CONTAINER_LIST_LIMIT + 50 });

      expect(listDismissedMock).toHaveBeenCalledWith({
        limit: MAX_SHARED_CONTAINER_LIST_LIMIT,
      });
    });

    it('reports an older server as unsupported instead of failing the listing', async () => {
      listDismissedMock.mockRejectedValue(unsupported());

      await expect(listDismissed({ organizationId: 'org-1' })).resolves.toEqual(
        { unsupported: true },
      );
    });

    it('rethrows a genuine listing failure', async () => {
      listDismissedMock.mockRejectedValue(
        new CanopyCloudClientError('http-error', 'Server error', 500),
      );

      await expect(listDismissed({})).rejects.toThrow('Server error');
    });

    it('validates the removed-share listing request and the feature flag', async () => {
      await expect(
        Promise.resolve().then(() => listDismissed({ organizationId: '' })),
      ).rejects.toThrow();
      isFeatureEnabledMock.mockReturnValue(false);
      await expect(
        Promise.resolve().then(() => listDismissed({})),
      ).rejects.toThrow();
      await expect(
        Promise.resolve().then(() => restore({ containerId: 'container-1' })),
      ).rejects.toThrow();
      expect(listDismissedMock).not.toHaveBeenCalled();
      expect(restoreMock).not.toHaveBeenCalled();
    });

    it('restores a share and tells every section at once', async () => {
      restoreMock.mockResolvedValue({ container });

      await expect(
        restore({ containerId: 'container-1', organizationId: 'org-1' }),
      ).resolves.toEqual({ restored: true, container });
      expect(restoreMock).toHaveBeenCalledWith('container-1', 'org-1');
      expect(signalLocalChangeMock).toHaveBeenCalledTimes(1);
      // A restored share is a pending invitation: nothing is accepted for it.
      await expect(
        handlers.get(IPC_CHANNELS.sharedContainersListAccepted)?.(
          {},
          undefined,
        ),
      ).resolves.toEqual({ containerIds: [], records: {} });
    });

    it('reports a share that can no longer be restored, without a signal', async () => {
      restoreMock.mockRejectedValue(notRestorable());

      await expect(restore({ containerId: 'container-1' })).resolves.toEqual({
        restored: false,
        reason: 'not-restorable',
      });
      expect(restoreMock).toHaveBeenCalledWith('container-1', undefined);
      expect(signalLocalChangeMock).not.toHaveBeenCalled();
    });

    it('reports an older server as unsupported on restore', async () => {
      restoreMock.mockRejectedValue(unsupported());

      await expect(restore({ containerId: 'container-1' })).resolves.toEqual({
        restored: false,
        reason: 'unsupported',
      });
      expect(signalLocalChangeMock).not.toHaveBeenCalled();
    });

    it('rethrows restore failures that are not a definitive answer', async () => {
      // A bare 404 without the dismissal code can be a proxy or a route miss.
      restoreMock.mockRejectedValue(
        new CanopyCloudClientError('http-error', 'Not found', 404),
      );
      await expect(restore({ containerId: 'container-1' })).rejects.toThrow(
        'Not found',
      );
      restoreMock.mockRejectedValue(
        new CanopyCloudClientError('network-error', 'offline'),
      );
      await expect(restore({ containerId: 'container-1' })).rejects.toThrow(
        'offline',
      );
      await expect(
        Promise.resolve().then(() => restore({ containerId: '' })),
      ).rejects.toThrow();
      expect(signalLocalChangeMock).not.toHaveBeenCalled();
    });

    it('signals a local change after a successful remove only', async () => {
      recipientDismissMock.mockResolvedValue(undefined);
      await handlers.get(IPC_CHANNELS.sharedContainersDismiss)?.(
        {},
        { containerId: 'container-1', organizationId: 'org-1' },
      );
      expect(signalLocalChangeMock).toHaveBeenCalledTimes(1);

      recipientDismissMock.mockRejectedValue(new Error('offline'));
      await expect(
        handlers.get(IPC_CHANNELS.sharedContainersDismiss)?.(
          {},
          { containerId: 'container-2', organizationId: 'org-1' },
        ),
      ).rejects.toThrow('offline');
      expect(signalLocalChangeMock).toHaveBeenCalledTimes(1);
    });
  });

  it('drops acceptance when the recipient dismisses the share', async () => {
    recipientDismissMock.mockResolvedValue(undefined);
    await handlers.get(IPC_CHANNELS.sharedContainersAccept)?.(
      {},
      { containerId: 'container-1', organizationId: 'org-1' },
    );

    await expect(
      handlers.get(IPC_CHANNELS.sharedContainersDismiss)?.(
        {},
        { containerId: 'container-1', organizationId: 'org-1' },
      ),
    ).resolves.toEqual({ dismissed: true });

    await expect(
      handlers.get(IPC_CHANNELS.sharedContainersListAccepted)?.({}, undefined),
    ).resolves.toEqual({ containerIds: [], records: {} });
    await expect(
      handlers.get(IPC_CHANNELS.sharedContainersOpen)?.(
        {},
        { containerId: 'container-1', organizationId: 'org-1' },
      ),
    ).rejects.toThrow('has not been accepted');
  });

  it('validates every local and server id at the boundary', async () => {
    const handler = handlers.get(IPC_CHANNELS.sharedContainersInvite);
    await expect(
      handler?.(
        {},
        {
          projectId: 'INVALID',
          worktreeId: 'worktree-1',
          organizationId: 'org-1',
          recipient: { kind: 'member', userId: 'user-1' },
          containerType: 'CODE_WORKTREE',
          capabilities: ['VIEW'],
        },
      ),
    ).rejects.toThrow('Invalid projectId');
    expect(eligibilityMock).not.toHaveBeenCalled();
  });

  it('converts a billing-blocked listing refusal into a typed empty response', async () => {
    listWithMeMock.mockRejectedValue(
      new CanopyCloudClientError(
        'http-error',
        'forbidden',
        403,
        'blocked-by-org-billing',
      ),
    );

    await expect(
      handlers.get(IPC_CHANNELS.sharedContainersListWithMe)?.(
        {},
        { organizationId: 'org-1' },
      ),
    ).resolves.toEqual({
      containers: [],
      nextCursor: null,
      refusal: 'blocked-by-org-billing',
    });
    expect(recordAppDiagnosticMock).toHaveBeenCalledTimes(1);
    expect(recordAppDiagnosticMock.mock.calls[0]?.[0]).toMatchObject({
      kind: 'shared_container_listing_blocked',
      sharedContainerOrganizationId: 'org-1',
    });
  });

  it('does not consume the dedupe window when recording the diagnostic fails', async () => {
    // The stamp is written only after a SUCCESSFUL record. Stamping before the
    // attempt would let one transient observability failure suppress the
    // diagnostic for the whole window, so the condition would go unreported
    // even though every later listing re-encountered it.
    listWithMeMock.mockRejectedValue(
      new CanopyCloudClientError(
        'http-error',
        'forbidden',
        403,
        'blocked-by-org-billing',
      ),
    );
    recordAppDiagnosticMock.mockImplementationOnce(() => {
      throw new Error('observability unavailable');
    });
    const listWithMe = handlers.get(IPC_CHANNELS.sharedContainersListWithMe);

    // First attempt throws inside the recorder; the refusal must still convert.
    await expect(
      listWithMe?.({}, { organizationId: 'org-1' }),
    ).resolves.toEqual({
      containers: [],
      nextCursor: null,
      refusal: 'blocked-by-org-billing',
    });

    // The failed write left the window open, so the next listing retries it.
    await listWithMe?.({}, { organizationId: 'org-1' });
    expect(recordAppDiagnosticMock).toHaveBeenCalledTimes(2);
  });

  it('rethrows a billing refusal on a cursor page instead of converting it', async () => {
    // The purge in `ReconciliationService.listSharedWithMe` is gated on
    // `!request.cursor`, so converting a page-2+ refusal would produce exactly
    // what the conversion's placement exists to prevent: a benign refusal with
    // no replica purge. A mid-pagination lapse stays a retryable error, and the
    // retry starts a fresh cursor-less listing that does purge.
    listWithMeMock.mockRejectedValue(
      new CanopyCloudClientError(
        'http-error',
        'forbidden',
        403,
        'blocked-by-org-billing',
      ),
    );

    await expect(
      handlers.get(IPC_CHANNELS.sharedContainersListWithMe)?.(
        {},
        { organizationId: 'org-1', cursor: 'page-2' },
      ),
    ).rejects.toThrow('forbidden');
    expect(recordAppDiagnosticMock).not.toHaveBeenCalled();
  });

  it('records the error classification, never the server prose, in the diagnostic', async () => {
    // The server's `error` string is prose it may reword and which can embed
    // organization names. This diagnostic lands in GLOBAL app-events, so only
    // the machine-readable classification may be forwarded.
    listWithMeMock.mockRejectedValue(
      new CanopyCloudClientError(
        'http-error',
        "Acme Corporation's trial has ended. Subscribe to Business.",
        403,
        'blocked-by-org-billing',
      ),
    );

    await handlers.get(IPC_CHANNELS.sharedContainersListWithMe)?.(
      {},
      { organizationId: 'org-1' },
    );

    const recorded = recordAppDiagnosticMock.mock.calls[0]?.[0];
    expect(recorded).toMatchObject({
      kind: 'shared_container_listing_blocked',
      error: '403/blocked-by-org-billing',
    });
    expect(JSON.stringify(recorded)).not.toContain('Acme Corporation');
  });

  it('records the billing-block diagnostic once per organization per window', async () => {
    // The renderer re-lists on every replica broadcast, failed dismiss, and
    // account resync, and a lapsed org is queried on each one. Without the
    // dedupe a persistently lapsed account floods app-events with identical
    // entries and crowds out unrelated diagnostics inside the retention window.
    listWithMeMock.mockRejectedValue(
      new CanopyCloudClientError(
        'http-error',
        'forbidden',
        403,
        'blocked-by-org-billing',
      ),
    );
    const listWithMe = handlers.get(IPC_CHANNELS.sharedContainersListWithMe);

    await listWithMe?.({}, { organizationId: 'org-1' });
    await listWithMe?.({}, { organizationId: 'org-1' });
    await listWithMe?.({}, { organizationId: 'org-1' });

    expect(recordAppDiagnosticMock).toHaveBeenCalledTimes(1);

    // A DIFFERENT organization is a distinct condition and still records.
    await listWithMe?.({}, { organizationId: 'org-2' });
    expect(recordAppDiagnosticMock).toHaveBeenCalledTimes(2);
    expect(recordAppDiagnosticMock.mock.calls[1]?.[0]).toMatchObject({
      sharedContainerOrganizationId: 'org-2',
    });
  });

  it('converts an unavailable listing into a typed retryable response', async () => {
    listWithMeMock.mockRejectedValue(
      new CanopyCloudClientError(
        'http-error',
        'service unavailable',
        503,
        'database_unavailable',
        undefined,
        true,
        7_000,
      ),
    );

    await expect(
      handlers.get(IPC_CHANNELS.sharedContainersListWithMe)?.(
        {},
        { organizationId: 'org-1' },
      ),
    ).resolves.toEqual({
      containers: [],
      nextCursor: null,
      refusal: 'temporarily-unavailable',
      retryAfterMs: 7_000,
    });
    expect(recordAppDiagnosticMock).toHaveBeenCalledWith(
      expect.objectContaining({
        kind: 'shared_container_listing_unavailable',
        error: '503/database_unavailable',
      }),
    );
  });

  it('converts a network failure on a cursor page into a typed retryable response', async () => {
    listWithMeMock.mockRejectedValue(
      new CanopyCloudClientError('network-error', 'offline'),
    );

    await expect(
      handlers.get(IPC_CHANNELS.sharedContainersListWithMe)?.(
        {},
        { organizationId: 'org-1', cursor: 'page-2' },
      ),
    ).resolves.toEqual({
      containers: [],
      nextCursor: null,
      refusal: 'temporarily-unavailable',
    });
  });

  it('serves recipient replica operations without leaking transport secrets', async () => {
    listWithMeMock.mockResolvedValue({ containers: [], nextCursor: null });
    const state = {
      status: 'available',
      containerId: 'container-1',
      organizationId: 'org-1',
      containerType: 'COWORK_WORK_ENTRY',
      revisionId: 'revision-1',
      revision: 1,
      revisionCreatedAt: '2026-08-28T00:00:00.000Z',
      updatedAt: '2026-08-28T00:00:00.000Z',
    };
    recipientOpenMock.mockResolvedValue(state);
    recipientStateMock.mockResolvedValue(state);
    recipientDismissMock.mockResolvedValue(undefined);
    listReplicaChatsMock.mockResolvedValue({
      items: [{ chatId: 'chat-1', title: 'Chat', createdAt: 'now' }],
      nextCursor: null,
      truncated: false,
    });
    readReplicaNoteMock.mockResolvedValue('# Note\n');
    readReplicaRevisionMetadataMock.mockResolvedValue({
      title: 'Published title',
    });
    listReplicaRepositoriesMock.mockResolvedValue([
      { repoId: 'repo-1', repoName: 'repository' },
    ]);

    await expect(
      handlers.get(IPC_CHANNELS.sharedContainersListWithMe)?.(
        {},
        { organizationId: 'org-1' },
      ),
    ).resolves.toEqual({ containers: [], nextCursor: null });
    await expect(
      handlers.get(IPC_CHANNELS.sharedContainersAccept)?.(
        {},
        { containerId: 'container-1', organizationId: 'org-1' },
      ),
    ).resolves.toEqual({
      accepted: true,
      record: { organizationId: 'org-1' },
    });
    await expect(
      handlers.get(IPC_CHANNELS.sharedContainersOpen)?.(
        {},
        { containerId: 'container-1', organizationId: 'org-1' },
      ),
    ).resolves.toEqual(state);
    await expect(
      handlers.get(IPC_CHANNELS.sharedContainersReplicaState)?.(
        {},
        { containerId: 'container-1' },
      ),
    ).resolves.toEqual(state);
    await expect(
      handlers.get(IPC_CHANNELS.sharedContainersDismiss)?.(
        {},
        { containerId: 'container-1', organizationId: 'org-1' },
      ),
    ).resolves.toEqual({ dismissed: true });
    await expect(
      handlers.get(IPC_CHANNELS.sharedContainersListChats)?.(
        {},
        { containerId: 'container-1', revisionId: 'revision-1' },
      ),
    ).resolves.toMatchObject({ items: [{ chatId: 'chat-1' }] });
    await expect(
      handlers.get(IPC_CHANNELS.sharedContainersReadNote)?.(
        {},
        {
          containerId: 'container-1',
          revisionId: 'revision-1',
          itemId: 'note-1',
        },
      ),
    ).resolves.toBe('# Note\n');
    await expect(
      handlers.get(IPC_CHANNELS.sharedContainersReadRevisionMetadata)?.(
        {},
        { containerId: 'container-1', revisionId: 'revision-1' },
      ),
    ).resolves.toEqual({ title: 'Published title' });
    await expect(
      handlers.get(IPC_CHANNELS.sharedContainersListRepositories)?.(
        {},
        { containerId: 'container-1', revisionId: 'revision-1' },
      ),
    ).resolves.toEqual([{ repoId: 'repo-1', repoName: 'repository' }]);
    expect(listReplicaChatsMock).toHaveBeenCalledWith({
      containerId: 'container-1',
      revisionId: 'revision-1',
    });
    replicaChangedCallback?.(state);
    // A purge is forwarded verbatim too, and is covered by the same leak
    // assertions below: the scope discriminant is the only thing the renderer
    // is allowed to learn about a container it is not reading.
    replicaChangedCallback?.({
      purged: 'container',
      containerId: 'container-1',
    });
    replicaChangedCallback?.({ purged: 'all' });

    const serialized = JSON.stringify([
      recipientOpenMock.mock.results[0]?.value,
      sendMock.mock.calls,
    ]);
    expect(serialized).not.toContain('dataKey');
    expect(serialized).not.toContain('artifactObjectKey');
    expect(serialized).not.toContain('https://');
    expect(sendMock).toHaveBeenCalledWith(
      IPC_CHANNELS.sharedContainersReplicaChanged,
      state,
    );
    expect(sendMock).toHaveBeenCalledWith(
      IPC_CHANNELS.sharedContainersReplicaChanged,
      { purged: 'container', containerId: 'container-1' },
    );
    expect(sendMock).toHaveBeenCalledWith(
      IPC_CHANNELS.sharedContainersReplicaChanged,
      { purged: 'all' },
    );

    // Open progress reaches the renderer so a multi-second checkout can be
    // narrated instead of hiding behind one indeterminate spinner (CAN-2551).
    syncPhaseCallback?.({ containerId: 'container-1', phase: 'checking-out' });
    expect(sendMock).toHaveBeenCalledWith(
      IPC_CHANNELS.sharedContainersSyncPhase,
      { containerId: 'container-1', phase: 'checking-out' },
    );
  });

  it('prepares GitHub for a validated code worktree target', async () => {
    eligibilityMock.mockResolvedValue({
      eligible: false,
      reason: 'github-not-ready',
      githubReadiness: { status: 'push-required' },
    });
    prepareGithubMock.mockResolvedValue({ status: 'ready' });

    await expect(
      handlers.get(IPC_CHANNELS.sharedContainersPrepareGithub)?.(
        {},
        {
          projectId: 'project-1',
          worktreeId: 'worktree-1',
          organizationId: 'org-1',
          containerType: 'CODE_WORKTREE',
        },
      ),
    ).resolves.toEqual({ status: 'ready' });
    expect(prepareGithubMock).toHaveBeenCalledTimes(1);
  });

  it('prepares GitHub when the target is already fully eligible', async () => {
    // A concurrent window may have repaired the branch between render and
    // click. Preparation is idempotent, so this is a safe no-op rather than a
    // refusal.
    eligibilityMock.mockResolvedValue({
      eligible: true,
      serverWorktreeExternalId: 'external-1',
    });
    prepareGithubMock.mockResolvedValue({ status: 'ready' });

    await expect(
      handlers.get(IPC_CHANNELS.sharedContainersPrepareGithub)?.(
        {},
        {
          projectId: 'project-1',
          worktreeId: 'worktree-1',
          organizationId: 'org-1',
          containerType: 'CODE_WORKTREE',
        },
      ),
    ).resolves.toEqual({ status: 'ready' });
    expect(prepareGithubMock).toHaveBeenCalledTimes(1);
  });

  it.each([
    'guest-account',
    'blocked-by-org-billing',
    'unsupported-capability',
    'sync-blocked-by-org',
    'sync-disabled',
    'no-cloud-account',
  ])(
    'refuses to push a remote when eligibility is blocked by %s',
    async (reason) => {
      // This is the only handler in the domain that mutates a remote, so it
      // re-asks the eligibility question rather than trusting that the
      // renderer only rendered the button when it was allowed to.
      eligibilityMock.mockResolvedValue({ eligible: false, reason });
      prepareGithubMock.mockResolvedValue({ status: 'ready' });

      await expect(
        handlers.get(IPC_CHANNELS.sharedContainersPrepareGithub)?.(
          {},
          {
            projectId: 'project-1',
            worktreeId: 'worktree-1',
            organizationId: 'org-1',
            containerType: 'CODE_WORKTREE',
          },
        ),
      ).resolves.toEqual({
        status: 'blocked',
        readiness: { status: 'blocked', reason: 'unavailable' },
      });
      expect(prepareGithubMock).not.toHaveBeenCalled();
    },
  );

  it('rejects an unsafe target before preparing GitHub', async () => {
    prepareGithubMock.mockResolvedValue({ status: 'ready' });

    await expect(
      handlers.get(IPC_CHANNELS.sharedContainersPrepareGithub)?.(
        {},
        {
          projectId: '../escape',
          worktreeId: 'worktree-1',
          organizationId: 'org-1',
          containerType: 'CODE_WORKTREE',
        },
      ),
    ).rejects.toThrow();

    await expect(
      handlers.get(IPC_CHANNELS.sharedContainersPrepareGithub)?.(
        {},
        {
          projectId: 'project-1',
          worktreeId: 'worktree-1',
          organizationId: 'org-1',
          containerType: 'NOT_A_TYPE',
        },
      ),
    ).rejects.toThrow('Invalid containerType');
    expect(prepareGithubMock).not.toHaveBeenCalled();
  });

  it('refuses GitHub preparation for a cowork container', async () => {
    prepareGithubMock.mockResolvedValue({ status: 'ready' });

    await expect(
      handlers.get(IPC_CHANNELS.sharedContainersPrepareGithub)?.(
        {},
        {
          projectId: 'project-1',
          worktreeId: 'worktree-1',
          organizationId: 'org-1',
          containerType: 'COWORK_WORK_ENTRY',
        },
      ),
    ).rejects.toThrow('containerType does not match project type');
    expect(prepareGithubMock).not.toHaveBeenCalled();
  });

  it('rejects a forged container type before checking eligibility', async () => {
    eligibilityMock.mockResolvedValue({ eligible: false, reason: 'no-access' });

    await expect(
      handlers.get(IPC_CHANNELS.sharedContainersInvite)?.(
        {},
        {
          projectId: 'project-1',
          worktreeId: 'worktree-1',
          organizationId: 'org-1',
          recipient: { kind: 'member', userId: 'user-1' },
          containerType: 'COWORK_WORK_ENTRY',
          capabilities: ['VIEW'],
        },
      ),
    ).rejects.toThrow('containerType does not match project type');
    expect(eligibilityMock).not.toHaveBeenCalled();
  });

  it.each(['telemetry-throws', 'publication-fails'] as const)(
    'keeps confirmed grant telemetry independent of %s',
    async (mode) => {
      eligibilityMock.mockResolvedValue({
        eligible: true,
        serverWorktreeExternalId: 'server-worktree-1',
      });
      createMock.mockResolvedValue({
        container: { id: 'container-1' },
        grant: { id: 'grant-1' },
      });
      if (mode === 'telemetry-throws')
        mockRecordInviteSend.mockImplementationOnce(() => {
          throw new Error('telemetry');
        });
      else
        markNotPublishedMock.mockImplementationOnce(() =>
          Promise.reject(new Error('publication')),
        );
      const result = handlers.get(IPC_CHANNELS.sharedContainersInvite)?.(
        {},
        {
          projectId: 'project-1',
          worktreeId: 'worktree-1',
          organizationId: 'org-1',
          recipient: { kind: 'member', userId: 'user-1' },
          containerType: 'CODE_WORKTREE',
          audience: 'team',
          capabilities: ['VIEW'],
        },
      );
      if (mode === 'telemetry-throws')
        await expect(result).resolves.toMatchObject({ invited: true });
      else await expect(result).rejects.toThrow('publication');
      expect(mockRecordInviteSend).toHaveBeenCalledTimes(1);
      expect(mockRecordInviteSend).toHaveBeenCalledWith({
        inviteType: 'teammate_share',
        inviteId: 'container-1',
        grantId: 'grant-1',
        recipientKind: 'member',
        sendSurface: 'share_dialog',
        shareAudience: 'team',
        containerType: 'WORKTREE',
      });
    },
  );

  it('creates an anchored grant and reports not-published', async () => {
    eligibilityMock.mockResolvedValue({
      eligible: true,
      serverWorktreeExternalId: 'server-worktree-1',
    });
    createMock.mockResolvedValue({
      container: { id: 'container-1' },
      grant: { id: 'grant-1' },
    });
    markNotPublishedMock.mockReturnValue({ status: 'not-published' });
    const handler = handlers.get(IPC_CHANNELS.sharedContainersInvite);
    await expect(
      handler?.(
        {},
        {
          projectId: 'project-1',
          worktreeId: 'worktree-1',
          organizationId: 'org-1',
          recipient: { kind: 'member', userId: 'user-1' },
          containerType: 'CODE_WORKTREE',
          capabilities: ['VIEW'],
        },
      ),
    ).resolves.toMatchObject({
      invited: true,
      publicationState: { status: 'not-published' },
    });
    expect(createMock).toHaveBeenCalledWith({
      organizationId: 'org-1',
      worktreeId: 'server-worktree-1',
      recipient: { kind: 'member', userId: 'user-1' },
      capabilities: ['VIEW'],
    });
    expect(reserveSharedContainerAnchorMock).toHaveBeenCalledWith(
      'project-1',
      'worktree-1',
      'org-1',
      'server-worktree-1',
    );
    expect(
      reserveSharedContainerAnchorMock.mock.invocationCallOrder[0],
    ).toBeLessThan(createMock.mock.invocationCallOrder[0] ?? 0);
    // The grant path pins like the link path: after the share exists and
    // before its first publication is scheduled.
    expect(pinPreferredLayoutIfMissingMock).toHaveBeenCalledWith(
      'project-1',
      'worktree-1',
    );
    expect(createMock.mock.invocationCallOrder[0]).toBeLessThan(
      pinPreferredLayoutIfMissingMock.mock.invocationCallOrder[0] ?? 0,
    );
    expect(
      pinPreferredLayoutIfMissingMock.mock.invocationCallOrder[0],
    ).toBeLessThan(schedulePublicationMock.mock.invocationCallOrder[0] ?? 0);
    // An invite never pins over the owner's choice: only the if-missing pin,
    // which is a no-op for a scope that is off or already pinned.
    expect(pinPreferredLayoutMock).not.toHaveBeenCalled();
  });

  it('does not create a remote grant until the anchor reservation is durable', async () => {
    eligibilityMock.mockResolvedValue({
      eligible: true,
      serverWorktreeExternalId: 'server-worktree-1',
    });
    createMock.mockResolvedValue({
      container: { id: 'container-1' },
      grant: { id: 'grant-1' },
    });
    reserveSharedContainerAnchorMock.mockRejectedValue(
      new Error('sync map write failed'),
    );
    markNotPublishedMock.mockReturnValue({ status: 'not-published' });

    await expect(
      handlers.get(IPC_CHANNELS.sharedContainersInvite)?.(
        {},
        {
          projectId: 'project-1',
          worktreeId: 'worktree-1',
          organizationId: 'org-1',
          recipient: { kind: 'member', userId: 'user-1' },
          containerType: 'CODE_WORKTREE',
          capabilities: ['VIEW'],
        },
      ),
    ).rejects.toThrow('sync map write failed');
    expect(createMock).not.toHaveBeenCalled();
    expect(markNotPublishedMock).not.toHaveBeenCalled();
  });

  it('releases a newly reserved anchor when the server definitively rejects grant creation', async () => {
    eligibilityMock.mockResolvedValue({
      eligible: true,
      serverWorktreeExternalId: 'server-worktree-1',
    });
    createMock.mockRejectedValue(
      new CanopyCloudClientError('http-error', 'forbidden', 403),
    );

    await expect(
      handlers.get(IPC_CHANNELS.sharedContainersInvite)?.(
        {},
        {
          projectId: 'project-1',
          worktreeId: 'worktree-1',
          organizationId: 'org-1',
          recipient: { kind: 'member', userId: 'user-1' },
          containerType: 'CODE_WORKTREE',
          capabilities: ['VIEW'],
        },
      ),
    ).rejects.toThrow('forbidden');
    expect(releaseSharedContainerAnchorMock).toHaveBeenCalledWith(
      'project-1',
      'worktree-1',
      'org-1',
      'server-worktree-1',
    );
  });

  it('retains the anchor when a network failure leaves the remote outcome uncertain', async () => {
    eligibilityMock.mockResolvedValue({
      eligible: true,
      serverWorktreeExternalId: 'server-worktree-1',
    });
    createMock.mockRejectedValue(
      new CanopyCloudClientError('network-error', 'request timed out'),
    );

    await expect(
      handlers.get(IPC_CHANNELS.sharedContainersInvite)?.(
        {},
        {
          projectId: 'project-1',
          worktreeId: 'worktree-1',
          organizationId: 'org-1',
          recipient: { kind: 'member', userId: 'user-1' },
          containerType: 'CODE_WORKTREE',
          capabilities: ['VIEW'],
        },
      ),
    ).rejects.toThrow('request timed out');
    expect(releaseSharedContainerAnchorMock).not.toHaveBeenCalled();
  });

  it('serializes overlapping grant mutations that share an anchor', async () => {
    eligibilityMock.mockResolvedValue({
      eligible: true,
      serverWorktreeExternalId: 'server-worktree-1',
    });
    reserveSharedContainerAnchorMock
      .mockResolvedValueOnce(true)
      .mockResolvedValueOnce(true);
    let rejectFirstGrant: ((error: Error) => void) | undefined;
    let markFirstGrantStarted: (() => void) | undefined;
    const firstGrantStarted = new Promise<void>((resolve) => {
      markFirstGrantStarted = resolve;
    });
    createMock
      .mockImplementationOnce(() => {
        markFirstGrantStarted?.();
        return new Promise((_resolve, reject) => {
          rejectFirstGrant = reject;
        });
      })
      .mockResolvedValueOnce({
        container: { id: 'container-1' },
        grant: { id: 'grant-2' },
      });
    markNotPublishedMock.mockReturnValue({ status: 'not-published' });
    const handler = handlers.get(IPC_CHANNELS.sharedContainersInvite);
    const request = {
      projectId: 'project-1',
      worktreeId: 'worktree-1',
      organizationId: 'org-1',
      containerType: 'CODE_WORKTREE',
      capabilities: ['VIEW'],
    };

    const firstInvite = handler?.(
      {},
      { ...request, recipient: { kind: 'member', userId: 'user-1' } },
    );
    await firstGrantStarted;
    const secondInvite = handler?.(
      {},
      { ...request, recipient: { kind: 'member', userId: 'user-2' } },
    );

    await Promise.resolve();
    expect(createMock).toHaveBeenCalledTimes(1);

    rejectFirstGrant?.(
      new CanopyCloudClientError('http-error', 'forbidden', 403),
    );
    await expect(firstInvite).rejects.toThrow('forbidden');
    await expect(secondInvite).resolves.toMatchObject({ invited: true });
    expect(releaseSharedContainerAnchorMock).toHaveBeenCalledTimes(1);
    expect(
      releaseSharedContainerAnchorMock.mock.invocationCallOrder[0],
    ).toBeLessThan(
      reserveSharedContainerAnchorMock.mock.invocationCallOrder[1] ?? 0,
    );
  });

  it('forwards the organization on the container-scoped recipient routes', async () => {
    // `organizationId` is an ownership hint the server checks when present, so
    // the handler must carry it through rather than dropping it at the IPC
    // boundary.
    recipientsMock.mockResolvedValue({ recipients: [], nextCursor: null });
    revokeMock.mockResolvedValue(undefined);

    await handlers.get(IPC_CHANNELS.sharedContainersListRecipients)?.(
      {},
      { containerId: 'container-1', organizationId: 'org-1' },
    );
    expect(recipientsMock).toHaveBeenCalledWith({
      containerId: 'container-1',
      organizationId: 'org-1',
    });

    await expect(
      handlers.get(IPC_CHANNELS.sharedContainersRevokeRecipient)?.(
        {},
        {
          containerId: 'container-1',
          grantId: 'grant-1',
          organizationId: 'org-1',
        },
      ),
    ).resolves.toEqual({ revoked: true });
    expect(revokeMock).toHaveBeenCalledWith('container-1', 'grant-1', 'org-1');
  });

  it('drops legacy allowlist fields from worktree scopes', async () => {
    readFileScopeMock.mockResolvedValue({ includedPaths: [] });

    await expect(
      handlers.get(IPC_CHANNELS.sharedContainersSaveFileScope)?.(
        {},
        {
          projectId: 'project-1',
          worktreeId: 'worktree-1',
          includedPaths: [' src/a.ts ', '../escape'],
          legacyAllowlist: true,
        },
      ),
    ).resolves.toEqual({ fileScope: { includedPaths: [] } });
    expect(writeFileScopeMock).toHaveBeenCalledWith(
      'project-1',
      'worktree-1',
      expect.not.objectContaining({ legacyAllowlist: true }),
    );
    expect(writeFileScopeMock).toHaveBeenCalledWith('project-1', 'worktree-1', {
      includedPaths: [],
      includedNoteIds: [],
      excludedNoteIds: [],
      includedPromptIds: [],
      excludedPromptIds: [],
      runSharingEnabled: false,
      runSharingDisabled: false,
      includedRunScripts: [],
      excludedRunScripts: [],
    });
    expect(readFileScopeMock).toHaveBeenCalledWith('project-1', 'worktree-1');
  });

  describe('preferred layout on a scope save', () => {
    const save = (preferredLayout?: unknown): Promise<unknown> | undefined =>
      handlers.get(IPC_CHANNELS.sharedContainersSaveFileScope)?.(
        {},
        {
          projectId: 'project-1',
          worktreeId: 'worktree-1',
          includedPaths: [],
          ...(preferredLayout !== undefined ? { preferredLayout } : {}),
        },
      );

    it('pins the current layout after the scope write and returns the public shape', async () => {
      const pinned = {
        includedPaths: [],
        preferredLayout: {
          enabled: true,
          pinnedAt: '2026-10-13T00:00:00.000Z',
        },
      };
      readFileScopeMock.mockResolvedValue(pinned);

      await expect(save('pin-current')).resolves.toEqual({ fileScope: pinned });

      expect(pinPreferredLayoutMock).toHaveBeenCalledWith(
        'project-1',
        'worktree-1',
      );
      expect(writeFileScopeMock.mock.invocationCallOrder[0]).toBeLessThan(
        pinPreferredLayoutMock.mock.invocationCallOrder[0] ?? 0,
      );
      expect(writeFileScopeMock.mock.calls[0]?.[2]).not.toHaveProperty(
        'preferredLayout',
      );
    });

    it('still schedules the saved scope when the pin fails', async () => {
      pinPreferredLayoutMock.mockRejectedValueOnce(new Error('disk full'));

      await expect(save('pin-current')).rejects.toThrow('disk full');

      expect(writeFileScopeMock).toHaveBeenCalled();
      expect(scheduleKnownPublicationMock).toHaveBeenCalledWith(
        'project-1',
        'worktree-1',
        true,
      );
    });

    it('turns the preferred layout off on clear', async () => {
      readFileScopeMock.mockResolvedValue({
        includedPaths: [],
        preferredLayout: { enabled: false },
      });

      await expect(save('clear')).resolves.toEqual({
        fileScope: { includedPaths: [], preferredLayout: { enabled: false } },
      });

      expect(writeFileScopeMock).toHaveBeenCalledWith(
        'project-1',
        'worktree-1',
        expect.objectContaining({ preferredLayout: { enabled: false } }),
      );
      expect(pinPreferredLayoutMock).not.toHaveBeenCalled();
    });

    it.each([['keep'], [undefined]])(
      'leaves the preferred layout unchanged for %s',
      async (value) => {
        readFileScopeMock.mockResolvedValue({ includedPaths: [] });

        await save(value);

        // The store keeps the persisted value when the field is absent.
        expect(writeFileScopeMock.mock.calls[0]?.[2]).not.toHaveProperty(
          'preferredLayout',
        );
        expect(pinPreferredLayoutMock).not.toHaveBeenCalled();
      },
    );

    it('rejects an unknown preferred layout request', async () => {
      await expect(save('pin')).rejects.toThrow('Invalid preferredLayout');
      await expect(save(true)).rejects.toThrow('Invalid preferredLayout');

      expect(writeFileScopeMock).not.toHaveBeenCalled();
      expect(pinPreferredLayoutMock).not.toHaveBeenCalled();
    });
  });

  it('rejects an oversized approved-file scope at the IPC boundary', async () => {
    await expect(
      handlers.get(IPC_CHANNELS.sharedContainersSaveFileScope)?.(
        {},
        {
          projectId: 'project-1',
          worktreeId: 'worktree-1',
          includedPaths: Array.from(
            { length: 201 },
            (_, index) => `src/file-${index}.ts`,
          ),
        },
      ),
    ).rejects.toThrow('Too many includedPaths');
    expect(writeFileScopeMock).not.toHaveBeenCalled();

    await expect(
      handlers.get(IPC_CHANNELS.sharedContainersSaveFileScope)?.(
        {},
        {
          projectId: 'project-1',
          worktreeId: 'worktree-1',
          includedPaths: [],
          excludedPaths: Array.from(
            { length: 201 },
            (_, index) => `src/file-${index}.ts`,
          ),
        },
      ),
    ).rejects.toThrow('Too many excludedPaths');
    expect(writeFileScopeMock).not.toHaveBeenCalled();
  });

  it('round-trips Cowork exclusions and schedules an immediate republish', async () => {
    isCoworkWorkspaceMock.mockReturnValue(true);
    readFileScopeMock.mockResolvedValue({
      includedPaths: [],
      excludedPaths: ['nested/private.txt'],
    });

    await expect(
      handlers.get(IPC_CHANNELS.sharedContainersSaveFileScope)?.(
        {},
        {
          projectId: 'project-1',
          worktreeId: 'worktree-1',
          includedPaths: [],
          excludedPaths: [' nested\\private.txt ', '../escape'],
        },
      ),
    ).resolves.toEqual({
      fileScope: {
        includedPaths: [],
        excludedPaths: ['nested/private.txt'],
      },
    });
    expect(writeFileScopeMock).toHaveBeenCalledWith(
      'project-1',
      'worktree-1',
      expect.objectContaining({
        includedPaths: [],
        excludedPaths: ['nested/private.txt'],
      }),
    );
    expect(scheduleKnownPublicationMock).toHaveBeenCalledWith(
      'project-1',
      'worktree-1',
      true,
    );
  });

  it('round-trips note, prompt, and run exclusions', async () => {
    readFileScopeMock.mockResolvedValue({
      includedPaths: [],
      excludedNoteIds: ['note-1'],
      excludedPromptIds: ['prompt-1'],
      runSharingDisabled: true,
      excludedRunScripts: ['launch'],
    });

    await expect(
      handlers.get(IPC_CHANNELS.sharedContainersSaveFileScope)?.(
        {},
        {
          projectId: 'project-1',
          worktreeId: 'worktree-1',
          includedPaths: [],
          excludedNoteIds: ['note-1'],
          excludedPromptIds: ['prompt-1'],
          runSharingDisabled: true,
          excludedRunScripts: ['launch'],
        },
      ),
    ).resolves.toMatchObject({
      fileScope: {
        excludedNoteIds: ['note-1'],
        excludedPromptIds: ['prompt-1'],
        runSharingDisabled: true,
        excludedRunScripts: ['launch'],
      },
    });
    expect(writeFileScopeMock).toHaveBeenCalledWith(
      'project-1',
      'worktree-1',
      expect.objectContaining({
        excludedNoteIds: ['note-1'],
        excludedPromptIds: ['prompt-1'],
        runSharingDisabled: true,
        excludedRunScripts: ['launch'],
      }),
    );
  });

  it('round-trips an explicit empty legacy Cowork allowlist', async () => {
    isCoworkWorkspaceMock.mockReturnValue(true);
    readFileScopeMock.mockResolvedValue({
      includedPaths: [],
      legacyAllowlist: true,
    });

    await expect(
      handlers.get(IPC_CHANNELS.sharedContainersSaveFileScope)?.(
        {},
        {
          projectId: 'project-1',
          worktreeId: 'worktree-1',
          includedPaths: [],
          legacyAllowlist: true,
        },
      ),
    ).resolves.toEqual({
      fileScope: { includedPaths: [], legacyAllowlist: true },
    });
    expect(writeFileScopeMock).toHaveBeenCalledWith(
      'project-1',
      'worktree-1',
      expect.objectContaining({
        includedPaths: [],
        legacyAllowlist: true,
      }),
    );
  });

  it('rejects approved paths that are not current untracked candidates', async () => {
    isCoworkWorkspaceMock.mockReturnValue(true);
    untrackedCandidatesMock.mockResolvedValue(['src/new.ts']);

    await expect(
      handlers.get(IPC_CHANNELS.sharedContainersSaveFileScope)?.(
        {},
        {
          projectId: 'project-1',
          worktreeId: 'worktree-1',
          includedPaths: ['src/new.ts', '.env', '.git/config'],
          legacyAllowlist: true,
        },
      ),
    ).rejects.toThrow('includedPaths must be current untracked files');
    expect(untrackedCandidatesMock).toHaveBeenCalledWith(
      'project-1',
      'worktree-1',
    );
    expect(writeFileScopeMock).not.toHaveBeenCalled();
  });

  it('prunes a formerly approved path that is no longer untracked while saving current approvals', async () => {
    isCoworkWorkspaceMock.mockReturnValue(true);
    readFileScopeMock
      .mockResolvedValueOnce({
        includedPaths: ['src/formerly-untracked.ts'],
        legacyAllowlist: true,
      })
      .mockResolvedValueOnce({
        includedPaths: ['src/current.ts'],
        legacyAllowlist: true,
      });
    untrackedCandidatesMock.mockResolvedValue(['src/current.ts']);

    await expect(
      handlers.get(IPC_CHANNELS.sharedContainersSaveFileScope)?.(
        {},
        {
          projectId: 'project-1',
          worktreeId: 'worktree-1',
          includedPaths: ['src/formerly-untracked.ts', 'src/current.ts'],
          legacyAllowlist: true,
        },
      ),
    ).resolves.toEqual({
      fileScope: { includedPaths: ['src/current.ts'], legacyAllowlist: true },
    });
    expect(writeFileScopeMock).toHaveBeenCalledWith(
      'project-1',
      'worktree-1',
      expect.objectContaining({
        includedPaths: ['src/current.ts'],
        legacyAllowlist: true,
      }),
    );
  });

  it('keeps existing-access management available when the feature flag is disabled', async () => {
    isFeatureEnabledMock.mockReturnValue(false);
    const gatedRequests = [
      [IPC_CHANNELS.sharedContainersEligibility, {}],
      [IPC_CHANNELS.sharedContainersPrepareGithub, {}],
      [IPC_CHANNELS.sharedContainersPreview, {}],
      [IPC_CHANNELS.sharedContainersSaveFileScope, {}],
      [IPC_CHANNELS.sharedContainersInvite, {}],
      [IPC_CHANNELS.sharedContainersSearchMembers, {}],
    ] as const;

    for (const [channel, request] of gatedRequests) {
      await expect(handlers.get(channel)?.({}, request)).rejects.toThrow(
        'Shared containers are disabled',
      );
    }
    recipientsMock.mockResolvedValue({ recipients: [], nextCursor: null });
    revokeMock.mockResolvedValue(undefined);
    listByMeMock.mockResolvedValue({ containers: [], nextCursor: null });

    await expect(
      handlers.get(IPC_CHANNELS.sharedContainersListRecipients)?.(
        {},
        { containerId: 'container-1', organizationId: 'org-1' },
      ),
    ).resolves.toEqual({ recipients: [], nextCursor: null });
    await expect(
      handlers.get(IPC_CHANNELS.sharedContainersRevokeRecipient)?.(
        {},
        {
          containerId: 'container-1',
          grantId: 'grant-1',
          organizationId: 'org-1',
        },
      ),
    ).resolves.toEqual({ revoked: true });
    await expect(
      handlers.get(IPC_CHANNELS.sharedContainersListByMe)?.(
        {},
        {
          organizationId: 'org-1',
          projectId: 'project-1',
          worktreeId: 'worktree-1',
        },
      ),
    ).resolves.toEqual({ containers: [], nextCursor: null });
    expect(eligibilityMock).not.toHaveBeenCalled();
    expect(createMock).not.toHaveBeenCalled();
    expect(revokeMock).toHaveBeenCalledTimes(1);
  });

  it('revokes a personal container grant without an organization hint', async () => {
    revokeMock.mockResolvedValue(undefined);
    await expect(
      handlers.get(IPC_CHANNELS.sharedContainersRevokeRecipient)?.(
        {},
        { containerId: 'container-1', grantId: 'grant-1' },
      ),
    ).resolves.toEqual({ revoked: true });
    expect(revokeMock).toHaveBeenCalledWith(
      'container-1',
      'grant-1',
      undefined,
    );
  });

  it('rejects a revoke without a valid grant id or organization hint', async () => {
    await expect(
      handlers.get(IPC_CHANNELS.sharedContainersRevokeRecipient)?.(
        {},
        { containerId: 'container-1', recipientId: 'user-1' },
      ),
    ).rejects.toThrow('Invalid grantId');
    await expect(
      handlers.get(IPC_CHANNELS.sharedContainersRevokeRecipient)?.(
        {},
        {
          containerId: 'container-1',
          grantId: 'grant-1',
          organizationId: 'INVALID',
        },
      ),
    ).rejects.toThrow('Invalid organizationId');
    expect(revokeMock).not.toHaveBeenCalled();
  });

  it('resolves the durable server anchor for an owner management lookup', async () => {
    listByMeMock.mockResolvedValue({ containers: [], nextCursor: null });

    await expect(
      handlers.get(IPC_CHANNELS.sharedContainersListByMe)?.(
        {},
        {
          organizationId: 'org-1',
          projectId: 'project-1',
          worktreeId: 'worktree-1',
        },
      ),
    ).resolves.toEqual({ containers: [], nextCursor: null });
    expect(resolveServerWorktreeExternalIdMock).toHaveBeenCalledWith(
      'project-1',
      'worktree-1',
      'org-1',
    );
    expect(listByMeMock).toHaveBeenCalledWith({
      organizationId: 'org-1',
      worktreeId: 'server-worktree-1',
    });
  });

  it('returns an empty owner listing when no local server anchor exists', async () => {
    resolveServerWorktreeExternalIdMock.mockReturnValue(null);

    await expect(
      handlers.get(IPC_CHANNELS.sharedContainersListByMe)?.(
        {},
        {
          organizationId: 'org-1',
          projectId: 'project-1',
          worktreeId: 'worktree-1',
        },
      ),
    ).resolves.toEqual({ containers: [], nextCursor: null });
    expect(listByMeMock).not.toHaveBeenCalled();
  });

  it('maps an org-wide owner listing back to local worktrees', async () => {
    listByMeMock.mockResolvedValue({
      containers: [
        {
          id: 'container-1',
          organizationId: 'org-1',
          ownerUserId: 'user-1',
          worktreeId: 'server-worktree-1',
          containerType: 'WORKTREE',
          title: 'Container 1',
          revision: 3,
          createdAt: '2026-01-01T00:00:00.000Z',
          updatedAt: '2026-01-01T00:00:00.000Z',
          capabilities: ['VIEW'],
        },
        {
          id: 'container-2',
          organizationId: 'org-1',
          ownerUserId: 'user-1',
          worktreeId: 'server-worktree-2',
          containerType: 'WORKTREE',
          title: 'Container 2',
          revision: 0,
          createdAt: '2026-01-01T00:00:00.000Z',
          updatedAt: '2026-01-01T00:00:00.000Z',
          capabilities: ['VIEW'],
        },
      ],
      nextCursor: null,
    });
    buildLocalWorktreeIndexByServerExternalIdMock.mockReturnValue(
      new Map([
        [
          'server-worktree-1',
          { projectId: 'project-1', worktreeId: 'worktree-1' },
        ],
        [
          'server-worktree-2',
          { projectId: 'project-2', worktreeId: 'worktree-2' },
        ],
      ]),
    );

    await expect(
      handlers.get(IPC_CHANNELS.sharedContainersListOwnedTargets)?.(
        {},
        { organizationId: 'org-1' },
      ),
    ).resolves.toEqual({
      targets: [
        {
          projectId: 'project-1',
          worktreeId: 'worktree-1',
          organizationId: 'org-1',
          containerId: 'container-1',
          revision: 3,
        },
        {
          projectId: 'project-2',
          worktreeId: 'worktree-2',
          organizationId: 'org-1',
          containerId: 'container-2',
          revision: 0,
        },
      ],
      truncated: false,
    });
    // The org-wide listing must not pin a worktree: that is what makes one
    // call able to hydrate every row in the sidebar.
    expect(listByMeMock).toHaveBeenCalledWith({
      organizationId: 'org-1',
      limit: MAX_SHARED_CONTAINER_LIST_LIMIT,
    });
    // The reverse index is built once per invocation rather than once per
    // container: this listing fans over every organization during startup
    // hydration on the Electron main thread, so a per-container scan over
    // every workspace x worktree would be O(worktrees x containers).
    expect(buildLocalWorktreeIndexByServerExternalIdMock).toHaveBeenCalledTimes(
      1,
    );
    expect(buildLocalWorktreeIndexByServerExternalIdMock).toHaveBeenCalledWith(
      'org-1',
    );
  });

  it('drops containers whose server worktree is not anchored locally', async () => {
    listByMeMock.mockResolvedValue({
      containers: [
        {
          id: 'container-1',
          organizationId: 'org-1',
          ownerUserId: 'user-1',
          worktreeId: 'server-worktree-other',
          containerType: 'WORKTREE',
          title: 'Container 1',
          revision: 2,
          createdAt: '2026-01-01T00:00:00.000Z',
          updatedAt: '2026-01-01T00:00:00.000Z',
          capabilities: ['VIEW'],
        },
      ],
      nextCursor: null,
    });
    buildLocalWorktreeIndexByServerExternalIdMock.mockReturnValue(new Map());

    await expect(
      handlers.get(IPC_CHANNELS.sharedContainersListOwnedTargets)?.(
        {},
        { organizationId: 'org-1' },
      ),
    ).resolves.toEqual({ targets: [], truncated: false });
  });

  it('pages the org-wide owner listing and reports a bounded truncation', async () => {
    listByMeMock.mockImplementation((request: { cursor?: string }) =>
      Promise.resolve({
        containers: [
          {
            id: 'container-1',
            organizationId: 'org-1',
            ownerUserId: 'user-1',
            worktreeId: 'server-worktree-1',
            containerType: 'WORKTREE',
            title: 'Container 1',
            revision: 1,
            createdAt: '2026-01-01T00:00:00.000Z',
            updatedAt: '2026-01-01T00:00:00.000Z',
            capabilities: ['VIEW'],
          },
        ],
        nextCursor: `cursor-after-${request.cursor ?? 'start'}`,
      }),
    );
    buildLocalWorktreeIndexByServerExternalIdMock.mockReturnValue(
      new Map([
        [
          'server-worktree-1',
          { projectId: 'project-1', worktreeId: 'worktree-1' },
        ],
      ]),
    );

    await expect(
      handlers.get(IPC_CHANNELS.sharedContainersListOwnedTargets)?.(
        {},
        { organizationId: 'org-1', maxPages: 2 },
      ),
    ).resolves.toEqual({
      targets: [
        {
          projectId: 'project-1',
          worktreeId: 'worktree-1',
          organizationId: 'org-1',
          containerId: 'container-1',
          revision: 1,
        },
      ],
      truncated: true,
    });
    expect(listByMeMock).toHaveBeenCalledTimes(2);
    expect(listByMeMock).toHaveBeenLastCalledWith({
      organizationId: 'org-1',
      limit: MAX_SHARED_CONTAINER_LIST_LIMIT,
      cursor: 'cursor-after-start',
    });
    // One index for the whole paginated invocation, not one per page.
    expect(buildLocalWorktreeIndexByServerExternalIdMock).toHaveBeenCalledTimes(
      1,
    );
  });

  it('keeps the highest revision when two containers map to one worktree', async () => {
    listByMeMock.mockResolvedValue({
      containers: [
        {
          id: 'container-1',
          organizationId: 'org-1',
          ownerUserId: 'user-1',
          worktreeId: 'server-worktree-1',
          containerType: 'WORKTREE',
          title: 'Container 1',
          revision: 4,
          createdAt: '2026-01-01T00:00:00.000Z',
          updatedAt: '2026-01-01T00:00:00.000Z',
          capabilities: ['VIEW'],
        },
        {
          id: 'container-2',
          organizationId: 'org-1',
          ownerUserId: 'user-1',
          worktreeId: 'server-worktree-2',
          containerType: 'WORKTREE',
          title: 'Container 2',
          revision: 1,
          createdAt: '2026-01-01T00:00:00.000Z',
          updatedAt: '2026-01-01T00:00:00.000Z',
          capabilities: ['VIEW'],
        },
      ],
      nextCursor: null,
    });
    // A stale anchor mapping two server worktrees onto one local worktree.
    buildLocalWorktreeIndexByServerExternalIdMock.mockReturnValue(
      new Map([
        [
          'server-worktree-1',
          { projectId: 'project-1', worktreeId: 'worktree-1' },
        ],
        [
          'server-worktree-2',
          { projectId: 'project-1', worktreeId: 'worktree-1' },
        ],
      ]),
    );

    await expect(
      handlers.get(IPC_CHANNELS.sharedContainersListOwnedTargets)?.(
        {},
        { organizationId: 'org-1' },
      ),
    ).resolves.toEqual({
      targets: [
        {
          projectId: 'project-1',
          worktreeId: 'worktree-1',
          organizationId: 'org-1',
          containerId: 'container-1',
          revision: 4,
        },
      ],
      truncated: false,
    });
  });

  it('never asks the server for a page larger than the protocol allows', async () => {
    // The owner listing is the only shared-container caller that sets its own
    // page size, and the route parser rejects `limit > 50` outright
    // (`parseSharedContainerOwnerList` -> 400). Every organization's page then
    // rejects, the renderer store learns nothing, and the sidebar badge is
    // silently absent for the whole session - which is exactly what a page
    // size of 100 shipped. Assert the wire value against the protocol bound
    // rather than a local constant, so raising the desktop's own maximum can
    // never quietly reintroduce a rejected request.
    listByMeMock.mockResolvedValue({ containers: [], nextCursor: null });
    buildLocalWorktreeIndexByServerExternalIdMock.mockReturnValue(new Map());

    await handlers.get(IPC_CHANNELS.sharedContainersListOwnedTargets)?.(
      {},
      { organizationId: 'org-1' },
    );
    await handlers.get(IPC_CHANNELS.sharedContainersListOwnedTargets)?.(
      {},
      { organizationId: 'org-1', limit: 200 },
    );

    expect(listByMeMock).toHaveBeenCalledTimes(2);
    for (const [request] of listByMeMock.mock.calls) {
      expect(request.limit).toBeLessThanOrEqual(
        MAX_SHARED_CONTAINER_LIST_LIMIT,
      );
      expect(request.limit).toBeGreaterThanOrEqual(1);
    }
  });

  it('returns an empty complete answer when the rollout is disabled', async () => {
    // The org-wide listing runs unprompted at startup to hydrate an additive
    // sidebar badge, so a disabled rollout must cost zero network calls and
    // must not leave the renderer store permanently marked incomplete.
    isFeatureEnabledMock.mockReturnValue(false);
    try {
      await expect(
        handlers.get(IPC_CHANNELS.sharedContainersListOwnedTargets)?.(
          {},
          { organizationId: 'org-1' },
        ),
      ).resolves.toEqual({ targets: [], truncated: false });
    } finally {
      isFeatureEnabledMock.mockReturnValue(true);
    }
    expect(listByMeMock).not.toHaveBeenCalled();
  });

  it('validates the organization before an org-wide owner listing', async () => {
    await expect(
      handlers.get(IPC_CHANNELS.sharedContainersListOwnedTargets)?.(
        {},
        { organizationId: 'INVALID' },
      ),
    ).rejects.toThrow('Invalid organizationId');
    expect(listByMeMock).not.toHaveBeenCalled();
  });

  it('validates the local target before an owner management lookup', async () => {
    await expect(
      handlers.get(IPC_CHANNELS.sharedContainersListByMe)?.(
        {},
        {
          organizationId: 'org-1',
          projectId: 'INVALID',
          worktreeId: 'worktree-1',
        },
      ),
    ).rejects.toThrow('Invalid projectId');
    expect(listByMeMock).not.toHaveBeenCalled();
  });

  it('treats only the server-coded already-missing grant as revoked', async () => {
    revokeMock.mockRejectedValue(
      new CanopyCloudClientError(
        'http-error',
        'not found',
        404,
        'shared-container-grant-not-found',
      ),
    );

    await expect(
      handlers.get(IPC_CHANNELS.sharedContainersRevokeRecipient)?.(
        {},
        {
          containerId: 'container-1',
          grantId: 'grant-1',
          organizationId: 'org-1',
        },
      ),
    ).resolves.toEqual({ revoked: true });
  });

  it('does not hide an ambiguous revoke 404', async () => {
    revokeMock.mockRejectedValue(
      new CanopyCloudClientError('http-error', 'recipient not found', 404),
    );

    await expect(
      handlers.get(IPC_CHANNELS.sharedContainersRevokeRecipient)?.(
        {},
        {
          containerId: 'container-1',
          grantId: 'grant-1',
          organizationId: 'org-1',
        },
      ),
    ).rejects.toThrow('recipient not found');
  });

  it.each([
    [400, 'invite', 'invalid-request'],
    [403, 'invite', 'insufficient-role'],
    [403, 'billing', 'blocked-by-org-billing'],
    [403, 'read', 'unknown'],
    [403, 'revoke', 'unknown'],
    [404, 'read', 'not-found'],
    [409, 'invite', 'conflict'],
    [429, 'read', 'rate-limited'],
    [503, 'read', 'temporarily-unavailable'],
  ] as const)(
    'classifies HTTP %i for %s calls',
    (status, operation, expected) => {
      expect(
        classifySharedContainerError(
          new CanopyCloudClientError(
            'http-error',
            'server refusal',
            status,
            operation === 'invite' && status === 403
              ? 'insufficient-role'
              : operation === 'billing' && status === 403
                ? 'blocked-by-org-billing'
                : undefined,
          ),
        ),
      ).toBe(expected);
    },
  );

  it('classifies a network error as temporarily unavailable', () => {
    expect(
      classifySharedContainerError(
        new CanopyCloudClientError('network-error', 'offline'),
      ),
    ).toBe('temporarily-unavailable');
  });
  describe('external sharing', () => {
    const inviteRequest = {
      projectId: 'project-1',
      worktreeId: 'worktree-1',
      containerType: 'CODE_WORKTREE',
      capabilities: ['VIEW'],
    };

    beforeEach(() => {
      createMock.mockResolvedValue({
        container: { id: 'container-1' },
        grant: { id: 'grant-1' },
      });
      markNotPublishedMock.mockReturnValue({ status: 'not-published' });
    });

    it('invites an email recipient into a personal container without an organization', async () => {
      eligibilityMock.mockResolvedValue({
        eligible: true,
        serverWorktreeExternalId: 'server-worktree-1',
        audiences: { team: false, organization: false, public: true },
        ownerFixed: false,
      });

      await expect(
        handlers.get(IPC_CHANNELS.sharedContainersInvite)?.(
          {},
          {
            ...inviteRequest,
            audience: 'public',
            recipient: { kind: 'email', email: '  ada@example.com ' },
          },
        ),
      ).resolves.toMatchObject({ invited: true });
      expect(createMock).toHaveBeenCalledWith({
        worktreeId: 'server-worktree-1',
        recipient: { kind: 'email', email: 'ada@example.com' },
        capabilities: ['VIEW'],
      });
      expect(reserveSharedContainerAnchorMock).toHaveBeenCalledWith(
        'project-1',
        'worktree-1',
        undefined,
        'server-worktree-1',
      );
      expect(markNotPublishedMock).toHaveBeenCalledWith({
        projectId: 'project-1',
        worktreeId: 'worktree-1',
        containerId: 'container-1',
        containerType: 'CODE_WORKTREE',
      });
    });

    it('invites an email recipient into the fixed owning organization', async () => {
      eligibilityMock.mockResolvedValue({
        eligible: true,
        serverWorktreeExternalId: 'server-worktree-1',
        audiences: { team: true, organization: true, public: true },
        ownerOrganizationId: 'org-1',
        ownerFixed: true,
      });

      await expect(
        handlers.get(IPC_CHANNELS.sharedContainersInvite)?.(
          {},
          {
            ...inviteRequest,
            organizationId: 'org-1',
            audience: 'public',
            recipient: { kind: 'email', email: 'ada@example.com' },
          },
        ),
      ).resolves.toMatchObject({ invited: true });
      expect(createMock).toHaveBeenCalledWith({
        organizationId: 'org-1',
        worktreeId: 'server-worktree-1',
        recipient: { kind: 'email', email: 'ada@example.com' },
        capabilities: ['VIEW'],
      });
    });

    it('refuses an email invite when Public is unavailable', async () => {
      eligibilityMock.mockResolvedValue({
        eligible: true,
        serverWorktreeExternalId: 'server-worktree-1',
        audiences: { team: true, organization: true, public: false },
        publicBlockedReason: 'external-sharing-disabled',
        ownerOrganizationId: 'org-1',
        ownerFixed: true,
      });

      await expect(
        handlers.get(IPC_CHANNELS.sharedContainersInvite)?.(
          {},
          {
            ...inviteRequest,
            organizationId: 'org-1',
            recipient: { kind: 'email', email: 'ada@example.com' },
          },
        ),
      ).resolves.toEqual({
        invited: false,
        reason: 'external-sharing-disabled',
      });
      expect(reserveSharedContainerAnchorMock).not.toHaveBeenCalled();
      expect(createMock).not.toHaveBeenCalled();
    });

    it('refuses an email invite while external sharing is off', async () => {
      eligibilityMock.mockResolvedValue({
        eligible: true,
        serverWorktreeExternalId: 'server-worktree-1',
      });

      await expect(
        handlers.get(IPC_CHANNELS.sharedContainersInvite)?.(
          {},
          {
            ...inviteRequest,
            organizationId: 'org-1',
            recipient: { kind: 'email', email: 'ada@example.com' },
          },
        ),
      ).resolves.toEqual({
        invited: false,
        reason: 'external-sharing-disabled',
      });
      expect(createMock).not.toHaveBeenCalled();
    });

    it('refuses a member invite into a container owned by another organization', async () => {
      eligibilityMock.mockResolvedValue({
        eligible: true,
        serverWorktreeExternalId: 'server-worktree-1',
        audiences: { team: true, organization: true, public: false },
        ownerOrganizationId: 'org-1',
        ownerFixed: true,
      });

      await expect(
        handlers.get(IPC_CHANNELS.sharedContainersInvite)?.(
          {},
          {
            ...inviteRequest,
            organizationId: 'org-2',
            audience: 'organization',
            recipient: { kind: 'member', userId: 'user-1' },
          },
        ),
      ).resolves.toEqual({
        invited: false,
        reason: 'anchored-to-other-organization',
      });
      expect(createMock).not.toHaveBeenCalled();
    });

    it('maps the server external-sharing refusal and releases the anchor', async () => {
      eligibilityMock.mockResolvedValue({
        eligible: true,
        serverWorktreeExternalId: 'server-worktree-1',
        audiences: { team: true, organization: true, public: true },
        ownerOrganizationId: 'org-1',
        ownerFixed: true,
      });
      createMock.mockRejectedValue(
        new CanopyCloudClientError(
          'http-error',
          'external sharing is off',
          403,
          'external-sharing-disabled',
        ),
      );

      await expect(
        handlers.get(IPC_CHANNELS.sharedContainersInvite)?.(
          {},
          {
            ...inviteRequest,
            organizationId: 'org-1',
            recipient: { kind: 'email', email: 'ada@example.com' },
          },
        ),
      ).resolves.toEqual({
        invited: false,
        reason: 'external-sharing-disabled',
      });
      expect(releaseSharedContainerAnchorMock).toHaveBeenCalledWith(
        'project-1',
        'worktree-1',
        'org-1',
        'server-worktree-1',
      );
    });

    it.each([
      { kind: 'email', email: 'not-an-address' },
      { kind: 'email', email: 'a@b@c' },
      { kind: 'email', email: 'a b@example.com' },
      { kind: 'email', email: `${'a'.repeat(245)}@example.com` },
      { kind: 'member', userId: 'NOT VALID' },
      { kind: 'phone', number: '555' },
      null,
    ])('rejects a malformed recipient %#', async (recipient) => {
      await expect(
        handlers.get(IPC_CHANNELS.sharedContainersInvite)?.(
          {},
          { ...inviteRequest, organizationId: 'org-1', recipient },
        ),
      ).rejects.toThrow(/Invalid recipient/);
      expect(eligibilityMock).not.toHaveBeenCalled();
    });

    it('rejects an unknown audience before checking eligibility', async () => {
      await expect(
        handlers.get(IPC_CHANNELS.sharedContainersEligibility)?.(
          {},
          { ...inviteRequest, audience: 'everyone' },
        ),
      ).rejects.toThrow('Invalid audience');
      expect(eligibilityMock).not.toHaveBeenCalled();
    });

    it('narrows member search to a team', async () => {
      membersMock.mockResolvedValue({ members: [] });
      await handlers.get(IPC_CHANNELS.sharedContainersSearchMembers)?.(
        {},
        { organizationId: 'org-1', teamId: 'team-1', query: 'ada' },
      );
      expect(membersMock).toHaveBeenCalledWith({
        organizationId: 'org-1',
        teamId: 'team-1',
        query: 'ada',
      });
      await expect(
        handlers.get(IPC_CHANNELS.sharedContainersSearchMembers)?.(
          {},
          { organizationId: 'org-1', teamId: 'NOT VALID' },
        ),
      ).rejects.toThrow('Invalid teamId');
    });

    it('lists direct shares when no organization is given', async () => {
      listWithMeMock.mockResolvedValue({ containers: [], nextCursor: null });
      await expect(
        handlers.get(IPC_CHANNELS.sharedContainersListWithMe)?.({}, {}),
      ).resolves.toEqual({ containers: [], nextCursor: null });
      expect(listWithMeMock).toHaveBeenCalledWith({});
    });

    it('reports a transient direct-listing outage as a typed refusal', async () => {
      listWithMeMock.mockRejectedValue(
        new CanopyCloudClientError('network-error', 'offline'),
      );
      await expect(
        handlers.get(IPC_CHANNELS.sharedContainersListWithMe)?.({}, {}),
      ).resolves.toEqual({
        containers: [],
        nextCursor: null,
        refusal: 'temporarily-unavailable',
      });
    });

    it('lists personal owned targets through the personal anchor index', async () => {
      listByMeMock.mockResolvedValue({
        containers: [
          {
            id: 'container-1',
            ownerUserId: 'user-1',
            worktreeId: 'server-worktree-1',
            containerType: 'CODE_WORKTREE',
            title: 'Container 1',
            revision: 1,
            createdAt: '2026-01-01T00:00:00.000Z',
            updatedAt: '2026-01-01T00:00:00.000Z',
            capabilities: ['VIEW'],
          },
        ],
        nextCursor: null,
      });
      buildLocalWorktreeIndexByServerExternalIdMock.mockReturnValue(
        new Map([
          [
            'server-worktree-1',
            { projectId: 'project-1', worktreeId: 'worktree-1' },
          ],
        ]),
      );

      await expect(
        handlers.get(IPC_CHANNELS.sharedContainersListOwnedTargets)?.({}, {}),
      ).resolves.toEqual({
        targets: [
          {
            projectId: 'project-1',
            worktreeId: 'worktree-1',
            containerId: 'container-1',
            revision: 1,
          },
        ],
        truncated: false,
      });
      expect(
        buildLocalWorktreeIndexByServerExternalIdMock,
      ).toHaveBeenCalledWith(undefined);
      expect(listByMeMock).toHaveBeenCalledWith({
        limit: MAX_SHARED_CONTAINER_LIST_LIMIT,
      });
    });

    it('opens a direct share without an organization hint', async () => {
      acceptedContainerIds.add('container-1');
      recipientOpenMock.mockResolvedValue({ status: 'nothing-published' });
      await handlers.get(IPC_CHANNELS.sharedContainersOpen)?.(
        {},
        { containerId: 'container-1', access: 'direct' },
      );
      expect(recipientOpenMock).toHaveBeenCalledWith(
        'container-1',
        undefined,
        false,
        'direct',
      );
      await expect(
        handlers.get(IPC_CHANNELS.sharedContainersOpen)?.(
          {},
          { containerId: 'container-1', access: 'public' },
        ),
      ).rejects.toThrow('Invalid access');
    });

    it('classifies the external-sharing refusal', () => {
      expect(
        classifySharedContainerError(
          new CanopyCloudClientError(
            'http-error',
            'refused',
            403,
            'external-sharing-disabled',
          ),
        ),
      ).toBe('external-sharing-disabled');
    });
  });
});
