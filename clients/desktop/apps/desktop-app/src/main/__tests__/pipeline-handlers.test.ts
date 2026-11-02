import { createHash } from 'node:crypto';
import type * as ProviderAuthStateModule from '../auth/provider-auth-state';
import type * as ShareablePluginResolution from '../plugins/shareable-plugin-resolution';
// Capability summaries use a local fixture rather than provider discovery.
jest.mock('../plugins/shareable-plugin-resolution', () => ({
  ...jest.requireActual<typeof ShareablePluginResolution>(
    '../plugins/shareable-plugin-resolution',
  ),
  loadShareablePluginCatalog: jest.fn().mockResolvedValue({
    skills: [],
    marketplaces: [],
  }),
}));
jest.mock('../lib/sidebar-items', () => ({ readAllSidebarItems: jest.fn() }));
jest.mock('../canopy-cloud/shared-item-subscriptions', () => ({
  recordSharedItemInstall: jest.fn(),
  recordSharedItemLocalUninstall: jest.fn(),
}));
import {
  recordSharedItemInstall,
  recordSharedItemLocalUninstall,
} from '../canopy-cloud/shared-item-subscriptions';
import { readAllSidebarItems } from '../lib/sidebar-items';
jest.mock('../lib/workspace-persistence', () => ({
  readWorkspaceConfigDetailed: jest.fn(),
}));
import * as workspacePersistence from '../lib/workspace-persistence';
import { classifyResourceOwner } from '@canopy/desktop-shared/lib/resource-context';
import { decideResourceContext } from '@canopy/desktop-shared/lib/resource-context-policy';
import * as pipelinePaths from '@canopy/desktop-shared/pipelines/config-paths';
import {
  saveStoredPipeline,
  deleteStoredPipeline,
  listStoredPipelines,
} from '@canopy/desktop-shared/pipelines/store';
import * as pipelineResourceLanes from '../pipelines/resource-lanes';
import * as pipelineInstallContext from '../pipelines/pipeline-install-context';
import {
  backgroundExecutionDeniedMessage,
  backgroundExecutionRetryMessage,
} from '@canopy/desktop-shared/node/background-execution-context';
import { CanopyCloudClientError } from '../canopy-cloud/client';
import { noteCloudWriteSent } from '../canopy-cloud/cloud-write-tracking';
import type { authorizeBackgroundExecution } from '../services/background-execution-context';
const mockBackgroundEnabled = jest.fn((): boolean => false);
const mockCaptureBackgroundContext = jest.fn<Promise<string | undefined>, []>(
  () => Promise.resolve(undefined),
);
const mockAuthorizeBackground = jest.fn<
  ReturnType<typeof authorizeBackgroundExecution>,
  Parameters<typeof authorizeBackgroundExecution>
>();
const mockAccountMayRunIn = jest.fn<Promise<boolean>, [unknown]>(() =>
  Promise.resolve(true),
);
jest.mock('../services/background-execution-context', () => ({
  accountMayRunIn: (context: unknown): Promise<boolean> =>
    mockAccountMayRunIn(context),
  backgroundExecutionContextEnabled: (): boolean => mockBackgroundEnabled(),
  captureBackgroundExecutionContext: (): Promise<string | undefined> =>
    mockCaptureBackgroundContext(),
  resolveBackgroundWorkspaceContext: jest.fn(
    (): Promise<string> =>
      Promise.resolve('org:aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa'),
  ),
  authorizeBackgroundExecution: (
    ...args: Parameters<typeof authorizeBackgroundExecution>
  ): ReturnType<typeof authorizeBackgroundExecution> =>
    mockAuthorizeBackground(...args),
  persistedPipelineContextResources: jest.fn(() => [
    { owner: { shareScope: 'private' } },
  ]),
}));
// The account has an organization, so Personal is a person's choice.
jest.mock('../lib/workspace-context-service', () => ({
  getWorkspaceContextService: (): unknown => ({
    initialize: (): Promise<void> => Promise.resolve(),
    whenIdle: (): Promise<void> => Promise.resolve(),
    getState: (): unknown => ({
      organizations: [{ id: 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa' }],
    }),
  }),
}));
const mockResolveProjectSavedOwner = jest.fn<Promise<unknown>, [unknown]>(() =>
  Promise.resolve({ kind: 'personal' }),
);
const mockDecideSameOwnerAccess = jest.fn<Promise<unknown>, [unknown, unknown]>(
  () => Promise.resolve({ kind: 'allowed' }),
);
jest.mock('../lib/project-owner', () => ({
  resolveProjectSavedOwner: (target: unknown): Promise<unknown> =>
    mockResolveProjectSavedOwner(target),
  decideSameOwnerAccess: (caller: unknown, target: unknown): Promise<unknown> =>
    mockDecideSameOwnerAccess(caller, target),
}));
// Pipeline local metadata, keyed by user pipeline id.
const mockPipelineMetadata = new Map<
  string,
  { owner?: string; agentAuthor?: unknown }
>();
let mockPipelineMetadataReadable = true;
const mockRecordUserPipelineOwner = jest.fn(
  (id: string, owner: string): void => {
    mockPipelineMetadata.set(id, { ...mockPipelineMetadata.get(id), owner });
  },
);
jest.mock('../pipelines/pipeline-local-metadata-store', () => ({
  isPipelineLocalMetadataReadable: (): boolean => mockPipelineMetadataReadable,
  readPipelineLocalMetadata: (locator: { value: string }): unknown =>
    mockPipelineMetadata.get(locator.value) ?? {},
  recordUserPipelineOwner: (id: string, owner: string): void =>
    mockRecordUserPipelineOwner(id, owner),
  setUserPipelineAgentAuthor: (id: string, author: unknown): void => {
    const entry = { ...mockPipelineMetadata.get(id) };
    delete entry.agentAuthor;
    mockPipelineMetadata.set(
      id,
      author ? { ...entry, agentAuthor: author } : entry,
    );
  },
  deleteUserPipelineLocalMetadata: (id: string): void => {
    mockPipelineMetadata.delete(id);
  },
}));
const mockLocalUserPipelineIds = new Set<string>();
jest.mock('@canopy/desktop-shared/pipelines/store', () => {
  const actual: Record<string, unknown> = jest.requireActual(
    '@canopy/desktop-shared/pipelines/store',
  );
  return {
    ...actual,
    getStoredPipelinePathWithSource: (id: string): unknown =>
      mockLocalUserPipelineIds.has(id)
        ? { success: true, data: { source: 'user', filePath: `/${id}.yaml` } }
        : { success: false, error: 'Pipeline not found' },
  };
});
jest.mock('../pipelines/curated-pipeline-catalog', () => ({
  listManagedCuratedPipelines: jest.fn().mockResolvedValue([]),
  getManagedCuratedPipeline: jest.fn(),
  startManagedCuratedPipelineSync: jest.fn(),
  stopManagedCuratedPipelineSync: jest.fn(),
}));
import {
  getManagedCuratedPipeline,
  listManagedCuratedPipelines,
} from '../pipelines/curated-pipeline-catalog';
jest.mock('../lib/git-executable', () => ({
  getGitExecutablePlatformStatus: jest.fn(() => ({ required: false })),
  getResolvedGitExecutableForSpawn: jest.fn(),
}));
import {
  getGitExecutablePlatformStatus,
  getResolvedGitExecutableForSpawn,
} from '../lib/git-executable';

jest.mock('@electron-toolkit/utils', () => ({
  is: { dev: true },
}));

jest.mock(
  '../canopy-runtime/pipeline-definition-dispatch',
  (): object =>
    jest.requireActual<{ pipelineWriteDispatchFake: object }>(
      './helpers/pipeline-write-dispatch-fake',
    ).pipelineWriteDispatchFake,
);
// The run-admission golden drives core; here a run keeps its caller copy.
jest.mock('../pipelines/run-definition-admission', () => ({
  admitStoredRunDefinition: (): Promise<null> => Promise.resolve(null),
}));
jest.mock('../pipelines/pipeline-service', () => ({
  listPipelines: jest.fn(),
  listPipelineCapabilityData: jest.fn(),
  getPipeline: jest.fn(),
  getStoredPipelineBySource: jest.fn(),
  savePipeline: jest.fn(),
  deletePipeline: jest.fn(),
  duplicatePipeline: jest.fn(),
  writePipelineRemoteMetadata: jest.fn(() => ({ success: true })),
  writeProjectPipelineRemoteMetadata: jest.fn(() => ({ success: true })),
  attachProjectPipelineRemoteMetadata: jest.fn(
    (pipelines: unknown[]): unknown[] => pipelines,
  ),
  clearProjectPipelineRemoteMetadataByRemoteId: jest.fn(() => ({
    success: true,
    data: 0,
  })),
  clearPipelineRemoteMetadataByRemoteId: jest.fn(() => ({
    success: true,
    data: 1,
  })),
}));
jest.mock('../pipelines/canopy-server-client', () => {
  const sharedPipeline = jest.fn();
  return {
    listSharedPipelines: jest.fn(),
    getSharedPipeline: sharedPipeline,
    getSharedPipelineForExecutionContext: jest.fn(
      (...args: unknown[]): unknown => sharedPipeline(...args),
    ),
    createSharedPipeline: jest.fn(),
    updateSharedPipeline: jest.fn(),
    deleteSharedPipeline: jest.fn(),
    publishPipelinePublicShare: jest.fn(),
    revokePipelinePublicShare: jest.fn(),
    listSharedOrganizations: jest.fn(),
    listSharedTeams: jest.fn(),
  };
});

const mockListAutomationsForImpact = jest.fn<
  Promise<
    Array<{ activity: ScheduledActivity; visibleInCurrentContext: boolean }>
  >,
  []
>();
jest.mock('../automations/service', () => ({
  getAutomationsService: (): {
    listActivitiesForSharedPipelineImpact: () => ReturnType<
      typeof mockListAutomationsForImpact
    >;
  } => ({
    listActivitiesForSharedPipelineImpact: mockListAutomationsForImpact,
  }),
}));
const mockGetSharedAutomationForImpact = jest.fn<
  Promise<SharedAutomationDetail>,
  [string]
>();
jest.mock('../automations/canopy-server-client', () => ({
  getSharedAutomation: (remoteId: string): Promise<SharedAutomationDetail> =>
    mockGetSharedAutomationForImpact(remoteId),
}));

import * as fs from 'node:fs';
import * as os from 'node:os';
import { getPipelineDataDir } from '../lib/paths';
import * as path from 'node:path';
import * as yaml from 'js-yaml';
import { BrowserWindow } from 'electron';
import type * as ExecutorModule from '@canopy/desktop-shared/node/pipelines/executor';
import type * as WorkspaceTargetExclusionModule from '../lib/workspace-target-exclusion';
import { PIPELINE_CHANNELS } from '@canopy/desktop-shared/constants/ipc-channels';
import { createDefaultEnvironmentConfig } from '@canopy/desktop-shared/lib/user-environment';
import type {
  ScheduledActivity,
  UsageMetricEvent,
  WorkspaceOwnerBinding,
} from '@canopy/desktop-shared/types';
import { commitWholeStepLog } from '@canopy/desktop-shared/node/pipelines/executor/step-log-positions';
import type {
  IPCResult,
  Pipeline,
  PipelineSaveInput,
  SharedPipelineDetail,
  SharedPipelinePublicShareInfo,
  SharedPipelineSaveImpact,
  StepLogReadResult,
} from '@canopy/desktop-shared/types/pipeline';
import type { SharedAutomationDetail } from '@canopy/protocol/automations';
import {
  createSharedPipeline,
  deleteSharedPipeline,
  getSharedPipeline,
  getSharedPipelineForExecutionContext,
  listSharedOrganizations,
  listSharedPipelines,
  listSharedTeams,
  publishPipelinePublicShare,
  revokePipelinePublicShare,
  updateSharedPipeline,
} from '../pipelines/canopy-server-client';
import type {
  cancelPipelineExecution,
  ExecutionEvent,
  ExecutionHandle,
  ExecutionRuntime,
  ExecutionOptions,
  ExecutionState,
  StepOutputEvent,
  executePipeline,
  loadExecutionState,
  resumePipeline,
  rerunPipelineExecution,
  retryMatrixJobExecution,
  retryPipelineExecution,
  saveExecutionState,
} from '@canopy/desktop-shared/node/pipelines/executor';
import * as pipelineService from '../pipelines/pipeline-service';
import { resolveWorktreeCwd } from '../lib/resolve-worktree';
import * as mainProcessLogging from '../lib/main-process-logging';
import { normalizePipeline } from '@canopy/desktop-shared/pipelines/normalize-pipeline';
import type {
  updatePlan,
  readTrackedPlanData,
} from '../services/plans-service';
import {
  acquireSplitLock,
  releaseSplitLock,
} from '../services/split-lock-service';

type ExecutePipelineFn = typeof executePipeline;
type CancelPipelineExecutionFn = typeof cancelPipelineExecution;
type LoadExecutionStateFn = typeof loadExecutionState;
type SaveExecutionStateFn = typeof saveExecutionState;
type ResumePipelineFn = typeof resumePipeline;
type RetryPipelineExecutionFn = typeof retryPipelineExecution;
type RetryMatrixJobExecutionFn = typeof retryMatrixJobExecution;
type RerunPipelineExecutionFn = typeof rerunPipelineExecution;
interface PipelineAdvisorWatchExecutionRequest {
  handle: ExecutionHandle;
  runtime: ExecutionRuntime;
  getWindow: () => BrowserWindow | null;
}

interface PipelineAdvisorExistingExecutionRequest {
  executionId: string;
  runtime: ExecutionRuntime;
  getWindow: () => BrowserWindow | null;
}

const registeredHandlers = new Map<string, (...args: unknown[]) => unknown>();
const mockRegisterIpcHandler = jest.fn(
  (channel: string, handler: (...args: unknown[]) => unknown) => {
    registeredHandlers.set(channel, handler);
  },
);
jest.mock('../ipc/register', () => ({
  get registerIpcHandler(): typeof mockRegisterIpcHandler {
    return mockRegisterIpcHandler;
  },
}));

const mockSendToAllWindows = jest.fn();
jest.mock('../lib/window-send', () => ({
  get sendToAllWindows(): typeof mockSendToAllWindows {
    return mockSendToAllWindows;
  },
}));

const mockWithWorkspaceTargetRuntimeStartReservation = jest.fn<
  void,
  [projectId: string, worktreeId: string, operation: () => Promise<unknown>]
>();
jest.mock('../lib/workspace-target-exclusion', () => {
  const actual = jest.requireActual<typeof WorkspaceTargetExclusionModule>(
    '../lib/workspace-target-exclusion',
  );
  return {
    ...actual,
    withWorkspaceTargetRuntimeStartReservation: <T>(
      projectId: string,
      worktreeId: string,
      operation: () => Promise<T>,
    ): Promise<T> => {
      mockWithWorkspaceTargetRuntimeStartReservation(
        projectId,
        worktreeId,
        operation,
      );
      return operation();
    },
  };
});

const mockSyncPipelineExecutionState = jest.fn();
const mockObservePipelineOutput = jest.fn();
const mockRecordUsageMetricEvent = jest.fn<void, [UsageMetricEvent]>();
const mockRecordAppDiagnostic = jest.fn();
jest.mock('../observability', () => ({
  getObservabilityService: jest.fn(() => ({
    get syncPipelineExecutionState(): typeof mockSyncPipelineExecutionState {
      return mockSyncPipelineExecutionState;
    },
    get observePipelineOutput(): typeof mockObservePipelineOutput {
      return mockObservePipelineOutput;
    },
    get recordUsageMetricEvent(): typeof mockRecordUsageMetricEvent {
      return mockRecordUsageMetricEvent;
    },
    get recordAppDiagnostic(): typeof mockRecordAppDiagnostic {
      return mockRecordAppDiagnostic;
    },
  })),
}));

type UpdatePlanFn = typeof updatePlan;
const mockUpdatePlan: jest.MockedFunction<UpdatePlanFn> = jest.fn();
const mockReadTrackedPlanData: jest.MockedFunction<typeof readTrackedPlanData> =
  jest.fn();
jest.mock('../services/plans-service', () => ({
  readTrackedPlanData: (
    ...args: Parameters<typeof readTrackedPlanData>
  ): ReturnType<typeof readTrackedPlanData> => mockReadTrackedPlanData(...args),
  updatePlan: (...args: Parameters<UpdatePlanFn>): ReturnType<UpdatePlanFn> =>
    mockUpdatePlan(...args),
}));

const mockHandlePipelineTerminalEvent = jest.fn();
jest.mock('../app-advisor/watchers', () => ({
  getAppAdvisorWatcherService: jest.fn(() => ({
    get handlePipelineTerminalEvent(): typeof mockHandlePipelineTerminalEvent {
      return mockHandlePipelineTerminalEvent;
    },
  })),
}));

const mockWatchExecution = jest.fn<
  void,
  [PipelineAdvisorWatchExecutionRequest]
>();
const mockRunForExistingExecution = jest.fn<
  Promise<unknown>,
  [PipelineAdvisorExistingExecutionRequest]
>();
jest.mock('../pipelines/pipeline-advisor', () => ({
  getPipelineAdvisorService: jest.fn(() => ({
    get watchExecution(): typeof mockWatchExecution {
      return mockWatchExecution;
    },
    get runForExistingExecution(): typeof mockRunForExistingExecution {
      return mockRunForExistingExecution;
    },
  })),
}));

const mockResolveLinearToken = jest.fn();
jest.mock('../lib/linear-auth', () => ({
  get resolveLinearToken(): typeof mockResolveLinearToken {
    return mockResolveLinearToken;
  },
}));

jest.mock('../lib/resolve-worktree', () => ({
  resolveWorktreeCwd: jest.fn(),
}));

const mockEnqueueKnownPrFastRefresh = jest.fn(() => Promise.resolve(false));
jest.mock('../lib/github-poller', () => ({
  get enqueueKnownPrFastRefresh(): typeof mockEnqueueKnownPrFastRefresh {
    return mockEnqueueKnownPrFastRefresh;
  },
}));

const mockReadPreferencesFile = jest.fn();
jest.mock('../lib/preferences-store', () => ({
  get readPreferencesFile(): typeof mockReadPreferencesFile {
    return mockReadPreferencesFile;
  },
}));

const mockGetCachedClaudeAuthStatusObserved = jest.fn<
  ReturnType<typeof ProviderAuthStateModule.getCachedClaudeAuthStatusObserved>,
  Parameters<typeof ProviderAuthStateModule.getCachedClaudeAuthStatusObserved>
>(() =>
  Promise.resolve({
    authenticated: true,
    accountLabel: 'dev@example.com',
    detail: null,
    error: null,
  }),
);
jest.mock('../auth/provider-auth-state', () => ({
  get getCachedClaudeAuthStatusObserved(): typeof mockGetCachedClaudeAuthStatusObserved {
    return mockGetCachedClaudeAuthStatusObserved;
  },
}));

const mockReleasePipelineResourceGuard = jest.fn();
const mockReservePipelineExecutionStart = jest.fn(() => ({
  release: mockReleasePipelineResourceGuard,
}));
jest.mock('../resource-monitor', () => ({
  getResourceMonitorService: jest.fn(() => ({
    get reservePipelineExecutionStart(): typeof mockReservePipelineExecutionStart {
      return mockReservePipelineExecutionStart;
    },
  })),
}));

const mockIsFeatureFlagEnabled = jest.fn(
  (key: string) => key !== 'canopy-shared-org-projects-enabled',
);
jest.mock('../feature-flags', () => ({
  getFeatureFlagService: jest.fn(() => ({
    isEnabled: mockIsFeatureFlagEnabled,
    onSnapshotChanged: jest.fn(() => (): void => undefined),
  })),
}));

const mockReadEnvironmentConfig = jest.fn();
jest.mock('../lib/user-environment-store', () => ({
  get readEnvironmentConfig(): typeof mockReadEnvironmentConfig {
    return mockReadEnvironmentConfig;
  },
}));

const mockBuildPipelineBaseBranchEnv = jest.fn();
jest.mock('../pipelines/worktree-base-branch-env', () => ({
  get buildPipelineBaseBranchEnv(): typeof mockBuildPipelineBaseBranchEnv {
    return mockBuildPipelineBaseBranchEnv;
  },
}));

let runtime: ExecutionRuntime;
const mockCreateElectronExecutionRuntime: jest.MockedFunction<
  (getWindow?: () => BrowserWindow | null) => ExecutionRuntime
> = jest.fn((): ExecutionRuntime => runtime);
jest.mock('../pipelines/execution-runtime', () => ({
  createElectronExecutionRuntime: (
    getWindow?: () => BrowserWindow | null,
  ): ExecutionRuntime => mockCreateElectronExecutionRuntime(getWindow),
}));

const mockExecutePipeline: jest.MockedFunction<ExecutePipelineFn> = jest.fn();
const mockCancelPipelineExecution: jest.MockedFunction<CancelPipelineExecutionFn> =
  jest.fn();
const mockLoadExecutionState: jest.MockedFunction<LoadExecutionStateFn> =
  jest.fn();
const mockSaveExecutionState: jest.MockedFunction<SaveExecutionStateFn> =
  jest.fn();
const mockResumePipeline: jest.MockedFunction<ResumePipelineFn> = jest.fn();
const mockRetryPipelineExecution: jest.MockedFunction<RetryPipelineExecutionFn> =
  jest.fn();
const mockRetryMatrixJobExecution: jest.MockedFunction<RetryMatrixJobExecutionFn> =
  jest.fn();
const mockRerunPipelineExecution: jest.MockedFunction<RerunPipelineExecutionFn> =
  jest.fn();
jest.mock('@canopy/desktop-shared/node/pipelines/executor', () => {
  const actual = jest.requireActual<typeof ExecutorModule>(
    '@canopy/desktop-shared/node/pipelines/executor',
  );
  return Object.defineProperties(
    {},
    {
      ...Object.getOwnPropertyDescriptors(actual),
      executePipeline: {
        value: (
          ...args: Parameters<ExecutePipelineFn>
        ): ReturnType<ExecutePipelineFn> => mockExecutePipeline(...args),
        enumerable: true,
      },
      cancelPipelineExecution: {
        value: (
          ...args: Parameters<CancelPipelineExecutionFn>
        ): ReturnType<CancelPipelineExecutionFn> =>
          mockCancelPipelineExecution(...args),
        enumerable: true,
      },
      loadExecutionState: {
        value: (
          ...args: Parameters<LoadExecutionStateFn>
        ): ReturnType<LoadExecutionStateFn> => mockLoadExecutionState(...args),
        enumerable: true,
      },
      saveExecutionState: {
        value: (
          ...args: Parameters<SaveExecutionStateFn>
        ): ReturnType<SaveExecutionStateFn> => mockSaveExecutionState(...args),
        enumerable: true,
      },
      resumePipeline: {
        value: (
          ...args: Parameters<ResumePipelineFn>
        ): ReturnType<ResumePipelineFn> => mockResumePipeline(...args),
        enumerable: true,
      },
      retryPipelineExecution: {
        value: (
          ...args: Parameters<RetryPipelineExecutionFn>
        ): ReturnType<RetryPipelineExecutionFn> =>
          mockRetryPipelineExecution(...args),
        enumerable: true,
      },
      retryMatrixJobExecution: {
        value: (
          ...args: Parameters<RetryMatrixJobExecutionFn>
        ): ReturnType<RetryMatrixJobExecutionFn> =>
          mockRetryMatrixJobExecution(...args),
        enumerable: true,
      },
      rerunPipelineExecution: {
        value: (
          ...args: Parameters<RerunPipelineExecutionFn>
        ): ReturnType<RerunPipelineExecutionFn> =>
          mockRerunPipelineExecution(...args),
        enumerable: true,
      },
    },
  );
});

import {
  cancelMatrixVariantFromMain,
  cancelPipelineExecutionFromMain,
  registerExecutionHandlers,
  registerPipelineHandlers,
  rerunPipelineExecutionFromMain,
  retryPipelineExecutionFromMain,
  retryMatrixJobFromMain,
  startPipelineExecutionFromMain,
} from '../pipelines/pipeline-handlers';
import { loadProjectPipelineFromDisk } from '../pipelines/project-pipeline-discovery';
import { writePipelineAdvisorSnapshot } from '../pipelines/pipeline-advisor-store';
import { getLedgerPipelineAgentOwners } from '../ledger/pipeline-agent-owners';
import { resetPipelineExecutionEventBroadcasterForTests } from '../pipelines/pipeline-execution-event-broadcaster';
import {
  releaseExecutionReservation,
  reserveExecution,
  trackExecution,
  tryReserveExecution,
} from '../pipelines/pipeline-execution-registry';
import * as pipelineExecutionRegistry from '../pipelines/pipeline-execution-registry';
import {
  GLOBAL_RUN_OWNER_CHECK_FAILED_MESSAGE,
  GLOBAL_RUN_TARGET_MESSAGE,
} from '../pipelines/pipeline-global-start';
import {
  CHOOSE_RUN_OWNER_MESSAGE,
  RUN_OWNER_UNAVAILABLE_MESSAGE,
} from '../pipelines/pipeline-owner-policy';
import { PIPELINE_NOW_OWNED_MESSAGE } from '@canopy/desktop-shared/types/pipeline';

const actualExecutorModule: typeof ExecutorModule = jest.requireActual(
  '@canopy/desktop-shared/node/pipelines/executor',
);
const mockResolveWorktreeCwd = jest.mocked(resolveWorktreeCwd);

afterEach(() => {
  resetPipelineExecutionEventBroadcasterForTests();
});

const mockedSavePipeline = jest.mocked(pipelineService.savePipeline);
const mockedListPipelineCapabilityData = jest.mocked(
  pipelineService.listPipelineCapabilityData,
);
const mockedGetStoredPipelineBySource = jest.mocked(
  pipelineService.getStoredPipelineBySource,
);
const mockedListSharedPipelines = jest.mocked(listSharedPipelines);
const mockedGetSharedPipeline = jest.mocked(getSharedPipeline);
const mockedGetSharedPipelineForExecutionContext = jest.mocked(
  getSharedPipelineForExecutionContext,
);
const mockedCreateSharedPipeline = jest.mocked(createSharedPipeline);
const mockedUpdateSharedPipeline = jest.mocked(updateSharedPipeline);
const mockedDeleteSharedPipeline = jest.mocked(deleteSharedPipeline);
const mockedListSharedOrganizations = jest.mocked(listSharedOrganizations);
const mockedListSharedTeams = jest.mocked(listSharedTeams);

function sparseWorkspaceOwnerBinding(
  organizationId: string,
): WorkspaceOwnerBinding {
  const owner: WorkspaceOwnerBinding = {
    type: 'organization',
    organizationId,
    projectId: 'project-a',
    instanceId: 'instance-a',
    bindingGeneration: 1,
  };
  // Preserve the intentionally sparse legacy owner payload used by these tests.
  Reflect.deleteProperty(owner, 'projectId');
  Reflect.deleteProperty(owner, 'instanceId');
  Reflect.deleteProperty(owner, 'bindingGeneration');
  return owner;
}

function createState(overrides: Partial<ExecutionState> = {}): ExecutionState {
  return {
    version: 1,
    id: 'execution-1',
    pipeline_id: 'pipeline-1',
    pipeline_snapshot: {
      name: 'Pipeline 1',
      scope: ['directory'],
      jobs: {},
      env: {},
      inputs: {},
    },
    status: 'success',
    jobs: {},
    job_definitions: {},
    job_groups: {},
    pending_pauses: [],
    status_reasons: [],
    started_at: '2026-03-27T12:00:00.000Z',
    cwd: '/stored/cwd',
    env: {
      FOO: 'bar',
      CANOPY_OUTPUT_DIR: '/stale/output',
    },
    inputs: {},
    event_name: 'dispatch',
    ...overrides,
  };
}

function pipelineWithoutTrigger(pipeline: Pipeline): Pipeline {
  // Preserve sparse legacy curated fixtures that intentionally omit `on`.
  Reflect.deleteProperty(pipeline, 'on');
  return pipeline;
}

function createHandle(
  state: ExecutionState,
  waitForCompletion: Promise<ExecutionState> = Promise.resolve(state),
): ExecutionHandle {
  return {
    id: state.id,
    cancel: jest.fn().mockResolvedValue(state),
    getState: () => state,
    waitForCompletion: () => waitForCompletion,
  };
}

function createDeferred<T>(): {
  promise: Promise<T>;
  resolve: (value: T) => void;
  reject: (reason?: unknown) => void;
} {
  let resolve: ((value: T) => void) | undefined;
  let reject: ((reason?: unknown) => void) | undefined;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });

  if (!resolve || !reject) {
    throw new Error('Deferred promise callbacks were not initialized');
  }

  return { promise, resolve, reject };
}

function isStepLogIpcResult(
  value: unknown,
): value is IPCResult<StepLogReadResult> {
  return (
    typeof value === 'object' &&
    value !== null &&
    typeof Reflect.get(value, 'success') === 'boolean'
  );
}

function createSharedPipelineDetail(
  overrides: Partial<SharedPipelineDetail> = {},
): SharedPipelineDetail {
  const name = overrides.name ?? 'Shared Pipeline';
  const description = overrides.description ?? 'Remote pipeline';
  const icon = overrides.icon ?? '☁️';
  const rawPipeline =
    overrides.rawPipeline ??
    [
      `name: ${name}`,
      `description: ${description}`,
      `icon: ${icon}`,
      'on: dispatch',
      'jobs:',
      '  build:',
      '    steps: []',
    ].join('\n');

  return {
    id: 'remote-1',
    name,
    description,
    icon,
    version: '1.0.0',
    triggerTypes: ['dispatch'] as Array<
      'dispatch' | 'plan_ready' | 'task_ready'
    >,
    createdBy: {
      id: 'user-1',
      name: 'Alice',
    },
    createdAt: '2026-04-26T12:00:00.000Z',
    updatedAt: '2026-04-26T12:00:00.000Z',
    canUpdate: true,
    canDelete: true,
    rawPipeline,
    contentHash: createHash('sha256').update(rawPipeline).digest('hex'),
    ...overrides,
  };
}

interface PipelinePreferenceFixture {
  gitExecutablePath: string;
  canopyBackgroundProcessesMode?: 'canopy' | 'terminal';
  pipelinesMode?: 'canopy' | 'terminal';
  prGenerationModel: string;
  prGenerationThinkingLevel: string;
  prInstructions: string;
  prInstructionMode: string;
  commitGenerationModel: string;
  commitGenerationThinkingLevel: string;
  commitInstructions: string;
  commitInstructionMode: string;
  rtkEnabled: boolean;
  codexMultiAgentPipelinesEnabled: boolean;
  codexMaxConcurrentSubagents?: number | null;
  localMemoryEnabled: boolean;
}

function listBundledAgentActionRefsFromResources(): string[] {
  const actionsDir = path.join(
    process.cwd(),
    'packages/desktop-shared/resources/actions',
  );
  return fs
    .readdirSync(actionsDir)
    .filter((entry) => {
      const manifestPath = path.join(actionsDir, entry, 'action.yml');
      if (!fs.existsSync(manifestPath)) {
        return false;
      }
      const raw = fs.readFileSync(manifestPath, 'utf8');
      const parsed = yaml.load(raw, { schema: yaml.JSON_SCHEMA });
      return (
        parsed !== null &&
        typeof parsed === 'object' &&
        !Array.isArray(parsed) &&
        (parsed as { log_format_hint?: unknown }).log_format_hint === 'agent'
      );
    })
    .map((entry) => `builtin/${entry}`)
    .sort((left, right) => left.localeCompare(right));
}

function listBundledAgentActionRefsFromUsageRecorderFastPath(): string[] {
  const handlerPath = path.join(
    process.cwd(),
    'apps/desktop-app/src/main/pipelines/pipeline-usage-events.ts',
  );
  const raw = fs.readFileSync(handlerPath, 'utf8');
  const match = raw.match(
    /const BUNDLED_AGENT_ACTION_REFS = new Set\(\[([\s\S]*?)\]\);/,
  );
  if (!match) {
    throw new Error(
      'Expected BUNDLED_AGENT_ACTION_REFS in pipeline-usage-events.ts',
    );
  }
  return Array.from(match[1].matchAll(/'([^']+)'/g))
    .map((entry) => entry[1])
    .sort((left, right) => left.localeCompare(right));
}

function makePipelinePreferences(
  overrides: Partial<PipelinePreferenceFixture> = {},
): PipelinePreferenceFixture {
  return {
    gitExecutablePath: '',
    prGenerationModel: 'claude-sonnet-4-6',
    prGenerationThinkingLevel: 'high',
    prInstructions: '',
    prInstructionMode: 'append',
    commitGenerationModel: 'claude-sonnet-4-6',
    commitGenerationThinkingLevel: 'high',
    commitInstructions: '',
    commitInstructionMode: 'append',
    rtkEnabled: true,
    codexMultiAgentPipelinesEnabled: false,
    localMemoryEnabled: true,
    ...overrides,
  };
}

function getHandler(
  channel: string,
): (_event: unknown, ...args: unknown[]) => Promise<unknown> {
  const handler = registeredHandlers.get(channel);
  if (!handler) {
    throw new Error(`No handler registered for ${channel}`);
  }
  return async (_event: unknown, ...args: unknown[]): Promise<unknown> =>
    Promise.resolve(Reflect.apply(handler, undefined, [_event, ...args]));
}

describe('project pipeline handlers', () => {
  let tempDir: string;
  let repoPath: string;
  let pipelinesDir: string;

  beforeEach(() => {
    jest.clearAllMocks();
    mockIsFeatureFlagEnabled.mockImplementation(
      (key: string) => key !== 'canopy-shared-org-projects-enabled',
    );
    registeredHandlers.clear();
    mockPipelineMetadataReadable = true;
    mockBackgroundEnabled.mockReturnValue(false);
    mockCaptureBackgroundContext.mockResolvedValue(undefined);
    mockAuthorizeBackground.mockResolvedValue({ allow: true });
    mockListAutomationsForImpact.mockResolvedValue([]);
    mockGetSharedAutomationForImpact.mockRejectedValue(
      new Error('Unexpected automation lookup'),
    );

    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'canopy-pipeline-ipc-'));
    repoPath = path.join(tempDir, 'repo');
    pipelinesDir = path.join(repoPath, '.canopy', 'pipelines');
    fs.mkdirSync(pipelinesDir, { recursive: true });

    runtime = {
      // Pipeline fixtures do not enforce an org model policy.
      isModelBlockedByOrgPolicy: (): Promise<boolean> => Promise.resolve(false),
      isOrgModelPolicyActive: (): Promise<boolean> => Promise.resolve(false),
      executionsDir: path.join(tempDir, 'executions'),
      tempRootDir: path.join(tempDir, 'tmp'),
      bundledActionsDir: path.join(tempDir, 'actions'),
      getProjectActionsDir: (inputRepoPath: string): string =>
        path.join(inputRepoPath, '.canopy', 'actions'),
      getProjectPipelinesDir: (inputRepoPath: string): string =>
        path.join(inputRepoPath, '.canopy', 'pipelines'),
    };

    mockExecutePipeline.mockResolvedValue({
      id: 'execution-1',
      cancel: () =>
        Promise.resolve({
          version: 1,
          id: 'execution-1',
          pipeline_id: 'project--deploy.yaml',
          pipeline_snapshot: {
            name: 'Captured',
            scope: ['directory'],
            jobs: {},
            env: {},
            inputs: {},
          },
          status: 'success',
          jobs: {},
          job_definitions: {},
          job_groups: {},
          pending_pauses: [],
          status_reasons: [],
          started_at: new Date().toISOString(),
          cwd: repoPath,
          env: {},
          inputs: {},
        }),
      getState: () => ({
        version: 1,
        id: 'execution-1',
        pipeline_id: 'project--deploy.yaml',
        pipeline_snapshot: {
          name: 'Captured',
          scope: ['directory'],
          jobs: {},
          env: {},
          inputs: {},
        },
        status: 'running',
        jobs: {},
        job_definitions: {},
        job_groups: {},
        pending_pauses: [],
        status_reasons: [],
        started_at: new Date().toISOString(),
        cwd: repoPath,
        env: {},
        inputs: {},
      }),
      waitForCompletion: () =>
        Promise.resolve({
          version: 1,
          id: 'execution-1',
          pipeline_id: 'project--deploy.yaml',
          pipeline_snapshot: {
            name: 'Captured',
            scope: ['directory'],
            jobs: {},
            env: {},
            inputs: {},
          },
          status: 'success',
          jobs: {},
          job_definitions: {},
          job_groups: {},
          pending_pauses: [],
          status_reasons: [],
          started_at: new Date().toISOString(),
          cwd: repoPath,
          env: {},
          inputs: {},
        }),
    });
    mockCancelPipelineExecution.mockResolvedValue(
      createState({
        id: 'execution-1',
        status: 'cancelled',
      }),
    );
    mockSaveExecutionState.mockImplementation(
      actualExecutorModule.saveExecutionState,
    );

    mockedSavePipeline.mockReturnValue({
      success: true,
      data: {
        id: 'copy-id',
        name: 'Deploy (Copy)',
        description: '',
        icon: '',
        filename: 'copy-id.yaml',
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
        source: 'user',
        readonly: false,
      },
    });

    mockReadPreferencesFile.mockResolvedValue(makePipelinePreferences());
    mockIsFeatureFlagEnabled.mockImplementation(
      (key: string) => key !== 'canopy-shared-org-projects-enabled',
    );
    mockGetCachedClaudeAuthStatusObserved.mockResolvedValue({
      authenticated: true,
      accountLabel: 'dev@example.com',
      detail: null,
      error: null,
    });
    mockReadEnvironmentConfig.mockResolvedValue({
      data: createDefaultEnvironmentConfig('2026-05-29T00:00:00.000Z'),
      encryptionAvailable: true,
    });
    mockResolveLinearToken.mockResolvedValue(null);
    mockBuildPipelineBaseBranchEnv.mockResolvedValue({
      CANOPY_BASE_BRANCH: 'develop',
      CANOPY_BASE_BRANCH_EXISTS_IN_REMOTE: 'true',
    });
    registerPipelineHandlers();
    registerExecutionHandlers(() => null);
  });

  afterEach(() => {
    fs.rmSync(tempDir, { recursive: true, force: true });
  });

  it('includes remote curated metadata in the standard pipeline list', async () => {
    jest
      .mocked(pipelineService.listPipelines)
      .mockReturnValue({ success: true, data: [] });
    jest.mocked(listManagedCuratedPipelines).mockResolvedValueOnce([
      {
        id: 'curated:review',
        source: 'curated',
        readonly: true,
        name: 'Review',
        filename: 'review.yaml',
        description: '',
        icon: '',
        createdAt: '',
        updatedAt: '',
        triggerTypes: ['task_ready'],
      },
    ]);
    expect(await getHandler(PIPELINE_CHANNELS.LIST)(undefined)).toMatchObject({
      success: true,
      data: [{ id: 'curated:review', source: 'curated' }],
    });
    expect(getManagedCuratedPipeline).not.toHaveBeenCalled();
  });

  it('fetches managed curated content for GET and creates an editable duplicate', async () => {
    const managed = {
      info: {
        id: 'curated:review',
        source: 'curated' as const,
        readonly: true,
        name: 'Review',
        filename: 'review.yaml',
        description: '',
        icon: '',
        createdAt: '',
        updatedAt: '',
        filePath: '/managed/hash/pipeline.yaml',
      },
      content: pipelineWithoutTrigger({
        name: 'Review',
        on: 'dispatch',
        readonly: true,
        jobs: { check: { steps: [{ run: 'echo verified' }] } },
      }),
    };
    jest.mocked(getManagedCuratedPipeline).mockResolvedValue(managed);
    expect(
      await getHandler(PIPELINE_CHANNELS.GET)(undefined, {
        source: 'curated',
        id: 'curated:review',
      }),
    ).toEqual({ success: true, data: managed });
    jest.mocked(pipelineService.savePipeline).mockReturnValue({
      success: true,
      data: { ...managed.info, id: 'copy', source: 'user', readonly: false },
    });
    await getHandler(PIPELINE_CHANNELS.DUPLICATE)(undefined, {
      source: 'curated',
      id: 'curated:review',
    });
    const savedInput = jest.mocked(pipelineService.savePipeline).mock
      .calls[0]?.[0];
    expect(savedInput?.name).toBe('Review (Copy)');
    expect(savedInput?.content).not.toHaveProperty('readonly', true);
  });

  it('requires re-review when curated inputs may have changed after modal selection', async () => {
    jest.mocked(getManagedCuratedPipeline).mockResolvedValue({
      info: {
        id: 'curated:review',
        source: 'curated',
        readonly: true,
        name: 'Review',
        filename: 'review.yaml',
        description: '',
        icon: '',
        createdAt: '',
        updatedAt: '',
        curatedContentHash: 'b'.repeat(64),
      },
      content: pipelineWithoutTrigger({
        name: 'Updated',
        on: 'dispatch',
        jobs: {},
      }),
    });
    const result = await getHandler(PIPELINE_CHANNELS.EXECUTE)(
      undefined,
      { name: 'Reviewed', jobs: {} },
      {
        cwd: repoPath,
        pipelineId: 'curated:review',
        pipelinePreferenceLocator: {
          type: 'stored',
          source: 'curated',
          value: 'curated:review',
          contentHash: 'a'.repeat(64),
        },
      },
    );
    expect(result).toMatchObject({
      success: false,
      error:
        'This curated workflow changed after you opened it. Reopen the launch dialog to review its updated inputs and try again.',
    });
    expect(mockExecutePipeline).not.toHaveBeenCalled();
  });

  it('rechecks the curated trigger against the verified definition at launch', async () => {
    jest.mocked(getManagedCuratedPipeline).mockResolvedValue({
      info: {
        id: 'curated:review',
        source: 'curated',
        readonly: true,
        name: 'Review',
        filename: 'review.yaml',
        description: '',
        icon: '',
        createdAt: '',
        updatedAt: '',
      },
      content: { name: 'Updated', on: 'plan_ready', jobs: {} },
    });
    expect(
      await getHandler(PIPELINE_CHANNELS.EXECUTE)(
        undefined,
        { name: 'Old', on: 'dispatch', jobs: {} },
        { cwd: repoPath, pipelineId: 'curated:review', eventName: 'dispatch' },
      ),
    ).toMatchObject({
      success: false,
      error:
        'This curated workflow no longer supports the selected trigger. Reopen the launch dialog and choose another workflow.',
    });
    expect(mockExecutePipeline).not.toHaveBeenCalled();
  });

  it('pins a verified managed revision at launch instead of trusting stale renderer content', async () => {
    const managed = {
      info: {
        id: 'curated:review',
        source: 'curated' as const,
        readonly: true,
        name: 'Review',
        filename: 'review.yaml',
        description: '',
        icon: '',
        createdAt: '',
        updatedAt: '',
        filePath: '/managed/account/key/hash/pipeline.yaml',
        curatedKey: 'review',
        curatedContentHash: 'a'.repeat(64),
        curatedRevision: 1,
      },
      content: pipelineWithoutTrigger({
        name: 'Current verified',
        on: 'dispatch',
        jobs: { check: { steps: [{ run: 'echo verified' }] } },
      }),
    };
    jest.mocked(getManagedCuratedPipeline).mockResolvedValue(managed);
    const result = await getHandler(PIPELINE_CHANNELS.EXECUTE)(
      undefined,
      { name: 'Stale renderer', jobs: {} },
      { cwd: repoPath, pipelineId: 'curated:review', eventName: 'dispatch' },
    );
    expect(result).toMatchObject({ success: true });
    expect(mockExecutePipeline).toHaveBeenCalledWith(
      managed.content,
      expect.objectContaining({
        pipelinePreferenceLocator: {
          type: 'stored',
          source: 'curated',
          value: 'curated:review',
          contentHash: 'a'.repeat(64),
        },
        pipelineFileDir: '/managed/account/key/hash',
        curatedPipelineSource: {
          key: 'review',
          contentHash: 'a'.repeat(64),
          revision: 1,
          cachedPipelinePath: '/managed/account/key/hash/pipeline.yaml',
        },
      }),
    );
  });

  it('hides project discovery metadata when the canonical owner is unavailable', async (): Promise<void> => {
    mockIsFeatureFlagEnabled.mockReturnValue(true);
    jest
      .mocked(readAllSidebarItems)
      .mockResolvedValue({ version: 1, items: [] });
    fs.writeFileSync(
      path.join(pipelinesDir, 'secret.yaml'),
      'name: Secret\non: dispatch\njobs: {}',
    );
    expect(
      await getHandler(PIPELINE_CHANNELS.DISCOVER_PROJECT)(undefined, repoPath),
    ).toEqual({ success: true, data: [] });
  });

  it('loads the latest project pipeline contents from disk on GET', async () => {
    const pipelinePath = path.join(pipelinesDir, 'deploy.yaml');
    fs.writeFileSync(
      pipelinePath,
      [
        'name: Deploy One',
        'on: dispatch',
        'jobs:',
        '  build:',
        '    steps: []',
      ].join('\n'),
      'utf8',
    );

    const getPipelineHandler = getHandler(PIPELINE_CHANNELS.GET);
    const firstResult = await getPipelineHandler(undefined, {
      id: 'project--deploy.yaml',
      cwd: repoPath,
      filePath: pipelinePath,
    });

    fs.writeFileSync(
      pipelinePath,
      [
        'name: Deploy Two',
        'on: dispatch',
        'jobs:',
        '  build:',
        '    steps: []',
      ].join('\n'),
      'utf8',
    );

    const secondResult = await getPipelineHandler(undefined, {
      id: 'project--deploy.yaml',
      cwd: repoPath,
      filePath: pipelinePath,
    });

    expect(firstResult).toMatchObject({
      success: true,
      data: {
        info: {
          source: 'project',
          readonly: true,
          filePath: pipelinePath,
        },
        content: {
          name: 'Deploy One',
        },
      },
    });
    expect(secondResult).toMatchObject({
      success: true,
      data: {
        content: {
          name: 'Deploy Two',
        },
      },
    });
  });

  describe('LIST_CAPABILITY_REFS', () => {
    it('loads stored pipeline definitions through the asynchronous catalog path', async () => {
      mockedListPipelineCapabilityData.mockResolvedValue({
        success: true,
        data: [
          {
            info: {
              id: 'stored-review',
              name: 'Stored Review',
              description: '',
              icon: '',
              filename: 'stored-review.yaml',
              createdAt: '2026-08-19T00:00:00.000Z',
              updatedAt: '2026-08-19T00:00:00.000Z',
              source: 'user',
              readonly: false,
            },
            content: {
              name: 'Stored Review',
              on: 'dispatch',
              jobs: {},
            },
          },
        ],
      });

      const result = await getHandler(PIPELINE_CHANNELS.LIST_CAPABILITY_REFS)(
        undefined,
      );

      expect(mockedListPipelineCapabilityData).toHaveBeenCalledTimes(1);
      expect(mockedGetStoredPipelineBySource).not.toHaveBeenCalled();
      expect(result).toMatchObject({
        success: true,
        data: {
          pipelines: [
            { id: 'stored-review', source: 'user', capabilities: [] },
          ],
        },
      });
    });

    it('ignores missing and relative cwd values', async () => {
      mockedListPipelineCapabilityData.mockResolvedValue({
        success: true,
        data: [],
      });

      const missing = await getHandler(PIPELINE_CHANNELS.LIST_CAPABILITY_REFS)(
        undefined,
      );
      const relative = await getHandler(PIPELINE_CHANNELS.LIST_CAPABILITY_REFS)(
        undefined,
        { cwd: 'relative/path' },
      );

      expect(missing).toEqual({ success: true, data: { pipelines: [] } });
      expect(relative).toEqual({ success: true, data: { pipelines: [] } });
    });

    it('keeps stored summaries when project discovery fails', async () => {
      mockedListPipelineCapabilityData.mockResolvedValue({
        success: true,
        data: [],
      });
      const badRepo = path.join(tempDir, 'bad-project-discovery');
      fs.mkdirSync(path.join(badRepo, '.canopy'), { recursive: true });
      fs.writeFileSync(
        path.join(badRepo, '.canopy', 'pipelines'),
        'not a directory',
        'utf8',
      );

      await expect(
        getHandler(PIPELINE_CHANNELS.LIST_CAPABILITY_REFS)(undefined, {
          cwd: badRepo,
        }),
      ).resolves.toEqual({ success: true, data: { pipelines: [] } });
    });

    it('returns a failure when the stored catalog cannot be loaded', async () => {
      mockedListPipelineCapabilityData.mockRejectedValue(
        new Error('catalog unavailable'),
      );

      await expect(
        getHandler(PIPELINE_CHANNELS.LIST_CAPABILITY_REFS)(undefined),
      ).resolves.toEqual({ success: false, error: 'catalog unavailable' });
    });
  });

  it('rejects project GET requests outside .canopy/pipelines', async () => {
    const outsidePath = path.join(tempDir, 'outside.yaml');
    fs.writeFileSync(
      outsidePath,
      [
        'name: Outside',
        'on: dispatch',
        'jobs:',
        '  build:',
        '    steps: []',
      ].join('\n'),
      'utf8',
    );

    const result = await getHandler(PIPELINE_CHANNELS.GET)(undefined, {
      id: 'project--outside',
      cwd: repoPath,
      filePath: outsidePath,
    });

    expect(result).toMatchObject({
      success: false,
    });
    expect(result).toHaveProperty(
      'error',
      expect.stringContaining('project pipelines directory'),
    );
  });

  it('rejects symlinked project GET requests that escape .canopy/pipelines', async () => {
    const outsidePath = path.join(tempDir, 'outside.yaml');
    fs.writeFileSync(
      outsidePath,
      [
        'name: Outside',
        'on: dispatch',
        'jobs:',
        '  build:',
        '    steps: []',
      ].join('\n'),
      'utf8',
    );

    const symlinkPath = path.join(pipelinesDir, 'link.yaml');
    fs.symlinkSync(outsidePath, symlinkPath);

    const result = await getHandler(PIPELINE_CHANNELS.GET)(undefined, {
      id: 'project--link.yaml',
      cwd: repoPath,
      filePath: symlinkPath,
    });

    expect(result).toMatchObject({
      success: false,
    });
    expect(result).toHaveProperty(
      'error',
      expect.stringContaining('symlink target'),
    );
  });

  it.each([
    [true, 'repository'],
    [false, 'repository'],
    [true, 'worktree'],
    [false, 'worktree'],
    [false, 'symlink'],
  ] as const)(
    'authorizes project GET without stored classification (organization=%s, location=%s)',
    async (organization, location): Promise<void> => {
      mockIsFeatureFlagEnabled.mockReturnValue(true);
      mockResolveWorktreeCwd.mockReturnValue(repoPath);
      jest.mocked(readAllSidebarItems).mockResolvedValue({
        version: 1,
        items: [
          {
            type: 'single-repo',
            id: 'project-a',
            name: 'Project',
            repoPath: location === 'worktree' ? tempDir : repoPath,
            worktrees:
              location === 'worktree'
                ? [
                    {
                      id: 'worktree-a',
                      branchName: 'main',
                      createdAt: '2026-09-24T00:00:00Z',
                    },
                  ]
                : [],
            color: '',
            collapsed: false,
            order: 0,
          },
        ],
      });
      jest
        .mocked(workspacePersistence.readWorkspaceConfigDetailed)
        .mockResolvedValue({
          authority: 'ok',
          ownerMalformed: false,
          memoryMalformed: false,
          config: {
            version: 1,
            type: 'single-repo',
            repos: [],
            repoPath,
            ...(organization
              ? { owner: sparseWorkspaceOwnerBinding('org-a') }
              : {}),
          },
        });
      const policy = jest
        .spyOn(pipelineResourceLanes, 'assertPipelineContext')
        .mockResolvedValue();
      const stored = jest
        .spyOn(pipelineInstallContext, 'assertStoredPipelineContext')
        .mockResolvedValue();
      if (location === 'symlink') {
        const foreignRoot = path.join(tempDir, 'foreign-pipelines');
        fs.mkdirSync(foreignRoot);
        fs.rmdirSync(pipelinesDir);
        fs.symlinkSync(foreignRoot, pipelinesDir);
      }
      const pipelinePath = path.join(pipelinesDir, 'deploy.yaml');
      fs.writeFileSync(pipelinePath, 'name: Deploy\non: dispatch\njobs: {}');
      try {
        const result = await getHandler(PIPELINE_CHANNELS.GET)(undefined, {
          id: 'project--deploy.yaml',
          cwd: repoPath,
          filePath: pipelinePath,
        });
        if (location === 'symlink') {
          expect(result).toEqual({
            success: false,
            error: 'Workflow unavailable (unsupported-target)',
          });
          expect(mockedSavePipeline).not.toHaveBeenCalled();
          return;
        }
        expect(result).toMatchObject({ success: true });
        expect(
          workspacePersistence.readWorkspaceConfigDetailed,
        ).toHaveBeenCalledWith('project-a');
        expect(policy).toHaveBeenCalledWith(
          {
            owner: {
              type: organization ? 'organization' : 'user',
              id: organization ? 'org-a' : 'local',
              name: null,
            },
          },
          undefined,
          undefined,
        );
        expect(stored).not.toHaveBeenCalled();
      } finally {
        policy.mockRestore();
        stored.mockRestore();
      }
    },
  );

  it.each(['user', 'app_advisor', 'portal'] as const)(
    'pins a %s foreground organization dispatch while preserving nested target overrides',
    async (initiationSource): Promise<void> => {
      const executionContext = 'org:aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa';
      mockBackgroundEnabled.mockReturnValue(true);
      mockCaptureBackgroundContext.mockResolvedValue(executionContext);
      jest.mocked(readAllSidebarItems).mockResolvedValue({
        version: 1,
        items: [
          {
            type: 'single-repo',
            id: 'project-1',
            name: 'Linked Personal',
            repoPath,
            worktrees: [
              { id: 'worktree-1', branchName: 'main', createdAt: '' },
            ],
            color: '',
            collapsed: false,
            order: 0,
          },
        ],
      });
      mockResolveWorktreeCwd.mockReturnValue(repoPath);
      mockAuthorizeBackground.mockImplementation(() =>
        Promise.resolve({ allow: true }),
      );
      mockedGetSharedPipeline.mockResolvedValue(
        createSharedPipelineDetail({
          id: 'remote-exec',
          rawPipeline:
            'name: Shared\non: dispatch\njobs:\n  build:\n    steps:\n      - uses: builtin/run-pipeline\n        target:\n          scope: directory\n          path: /tmp/child\n        with:\n          pipeline: child\n',
        }),
      );

      const result = await startPipelineExecutionFromMain({
        pipeline: { name: 'Selection', on: 'dispatch', jobs: {} },
        options: {
          cwd: repoPath,
          repoPath,
          projectId: 'project-1',
          worktreeId: 'worktree-1',
          pipelineId: 'shared:canopy-cloud:remote-exec',
          initiationSource,
          sharedPipeline: {
            serverId: 'canopy-cloud',
            remoteId: 'remote-exec',
          },
        },
        getWindow: () => null,
      });

      expect(result).toMatchObject({ success: true });
      expect(mockAuthorizeBackground).toHaveBeenCalledWith(
        executionContext,
        expect.any(Array),
        { projectId: 'project-1', worktreeId: 'worktree-1' },
      );
      expect(mockExecutePipeline).toHaveBeenCalledWith(
        expect.any(Object),
        expect.objectContaining({
          executionContext,
          allowUnverifiedForegroundChildren: true,
        }),
      );
      expect(
        mockExecutePipeline.mock.calls[0]?.[1].childPipelineAuthorizations,
      ).toBeUndefined();
    },
  );

  it('rejects an Ultra fast main-process pipeline before acquiring execution resources', async () => {
    const result = await startPipelineExecutionFromMain({
      pipeline: { name: 'Unsupported speed', on: 'dispatch', jobs: {} },
      options: {
        cwd: repoPath,
        pipelineId: 'unsupported-speed',
        modelConfig: { speed: 'ultrafast', fastMode: false },
      },
      getWindow: () => null,
    });
    expect(result).toEqual({
      success: false,
      error: 'Workflows do not support Ultra fast. Choose Regular or Fast.',
    });
    expect(mockReservePipelineExecutionStart).not.toHaveBeenCalled();
    expect(mockExecutePipeline).not.toHaveBeenCalled();
    expect(mockSaveExecutionState).not.toHaveBeenCalled();
  });

  it.each(['retry', 'rerun', 'matrix'] as const)(
    'rejects an Ultra fast pipeline %s before replaying or rewriting its state',
    async (kind) => {
      const state = createState({
        status: 'failure',
        model_config: { speed: 'ultrafast', fastMode: false },
      });
      mockLoadExecutionState.mockResolvedValue(state);
      mockRetryPipelineExecution.mockResolvedValue(createHandle(state));
      mockRerunPipelineExecution.mockResolvedValue(createHandle(state));
      mockRetryMatrixJobExecution.mockResolvedValue(createHandle(state));
      const error =
        'Workflows do not support Ultra fast. Choose Regular or Fast.';
      if (kind === 'matrix') {
        await expect(
          retryMatrixJobFromMain({
            request: { executionId: state.id, jobId: 'build', mode: 'failed' },
            getWindow: () => null,
          }),
        ).rejects.toThrow(error);
      } else {
        const replay =
          kind === 'retry'
            ? retryPipelineExecutionFromMain
            : rerunPipelineExecutionFromMain;
        await expect(
          replay({
            executionId: state.id,
            getWindow: () => null,
          }),
        ).resolves.toMatchObject({ success: false, error });
      }
      expect(mockRetryPipelineExecution).not.toHaveBeenCalled();
      expect(mockRerunPipelineExecution).not.toHaveBeenCalled();
      expect(mockRetryMatrixJobExecution).not.toHaveBeenCalled();
      expect(mockSaveExecutionState).not.toHaveBeenCalled();
    },
  );

  it.each(['retry', 'rerun'] as const)(
    'keeps a global %s global under its recorded owner and refuses it after access is removed',
    async (kind) => {
      const executionContext = 'org:aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa';
      const state = createState({
        status: 'failure',
        scope: 'global',
        execution_context: executionContext,
        initiator: { kind: 'user' },
      });
      mockLoadExecutionState.mockResolvedValue(state);
      mockRetryPipelineExecution.mockResolvedValue(createHandle(state));
      mockRerunPipelineExecution.mockResolvedValue(createHandle(state));
      mockBackgroundEnabled.mockReturnValue(true);
      mockAuthorizeBackground.mockResolvedValue({ allow: true });
      const replay =
        kind === 'retry'
          ? retryPipelineExecutionFromMain
          : rerunPipelineExecutionFromMain;
      const replayMock =
        kind === 'retry'
          ? mockRetryPipelineExecution
          : mockRerunPipelineExecution;

      await expect(
        replay({ executionId: state.id, getWindow: () => null }),
      ).resolves.toMatchObject({ success: true });
      expect(mockAuthorizeBackground).toHaveBeenCalledWith(
        executionContext,
        expect.any(Array),
        { scope: 'global' },
        expect.any(Array),
      );
      // A replay never recaptures the selected context or gains a target.
      expect(mockCaptureBackgroundContext).not.toHaveBeenCalled();
      const replayOptions = replayMock.mock.calls[0]?.[1];
      expect(replayOptions).toMatchObject({ executionContext });
      expect(replayOptions).not.toHaveProperty('projectId');
      expect(replayOptions).not.toHaveProperty('worktreeId');

      replayMock.mockClear();
      mockAuthorizeBackground.mockResolvedValue({
        allow: false,
        reason: 'access-removed',
      });
      await expect(
        replay({ executionId: state.id, getWindow: () => null }),
      ).resolves.toMatchObject({
        success: false,
        error: backgroundExecutionDeniedMessage('access-removed'),
      });
      expect(replayMock).not.toHaveBeenCalled();
    },
  );

  it('pins a custom stored foreground run to its organization context', async (): Promise<void> => {
    const executionContext = 'org:aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa';
    mockBackgroundEnabled.mockReturnValue(true);
    mockCaptureBackgroundContext.mockResolvedValue(executionContext);
    jest.mocked(readAllSidebarItems).mockResolvedValue({
      version: 1,
      items: [
        {
          type: 'single-repo',
          id: 'project-1',
          name: 'Linked Personal',
          repoPath,
          worktrees: [{ id: 'worktree-1', branchName: 'main', createdAt: '' }],
          color: '',
          collapsed: false,
          order: 0,
        },
      ],
    });
    mockResolveWorktreeCwd.mockReturnValue(repoPath);
    const stored = jest
      .spyOn(pipelineInstallContext, 'assertStoredPipelineContext')
      .mockResolvedValue();
    const resource = jest
      .spyOn(pipelineInstallContext, 'readStoredPipelineContext')
      .mockResolvedValue({
        owner: { type: 'user', id: 'local', name: null },
      });
    mockAuthorizeBackground.mockResolvedValue({ allow: true });
    try {
      const result = await startPipelineExecutionFromMain({
        pipeline: { name: 'Custom', on: 'dispatch', jobs: {} },
        options: {
          cwd: repoPath,
          repoPath,
          projectId: 'project-1',
          worktreeId: 'worktree-1',
          pipelineId: 'custom-pipeline',
          initiationSource: 'user',
        },
        getWindow: () => null,
      });
      expect(result).toMatchObject({ success: true });
      expect(mockExecutePipeline).toHaveBeenCalledWith(
        expect.any(Object),
        expect.objectContaining({ executionContext }),
      );
    } finally {
      stored.mockRestore();
      resource.mockRestore();
    }
  });

  it('pins a global foreground run without inventing a workspace target', async (): Promise<void> => {
    const executionContext = 'org:aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa';
    mockBackgroundEnabled.mockReturnValue(true);
    mockCaptureBackgroundContext.mockResolvedValue(executionContext);
    const stored = jest
      .spyOn(pipelineInstallContext, 'assertStoredPipelineContext')
      .mockResolvedValue();
    const resource = jest
      .spyOn(pipelineInstallContext, 'readStoredPipelineContext')
      .mockResolvedValue({ owner: { type: 'system' } });
    mockAuthorizeBackground.mockResolvedValue({ allow: true });
    try {
      const result = await startPipelineExecutionFromMain({
        pipeline: {
          name: 'Global',
          on: 'dispatch',
          scope: ['global'],
          jobs: {},
        },
        options: {
          scope: 'global',
          pipelineId: 'global-pipeline',
          initiationSource: 'user',
          requestedOwner: executionContext,
        },
        getWindow: () => null,
      });
      expect(result).toMatchObject({ success: true });
      expect(mockAuthorizeBackground).toHaveBeenCalledWith(
        executionContext,
        expect.any(Array),
        { scope: 'global' },
      );
      expect(mockExecutePipeline).toHaveBeenCalledWith(
        expect.any(Object),
        expect.objectContaining({ executionContext }),
      );
      // A global run works in its own folder.
      const options = mockExecutePipeline.mock.calls[0]?.[1];
      expect(options?.cwd).toBe(
        path.join(
          runtime.executionsDir,
          options?.executionId ?? '',
          'workspace',
        ),
      );
    } finally {
      stored.mockRestore();
      resource.mockRestore();
    }
  });

  describe('run owner and identity', () => {
    const ORG_A = 'org:aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa';
    const ORG_B = 'org:bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb';
    const AGENT_CHAT = {
      projectId: 'project-1',
      worktreeId: 'worktree-1',
      chatId: 'chat-1',
    };

    beforeEach(() => {
      mockPipelineMetadata.clear();
      mockLocalUserPipelineIds.clear();
      mockAccountMayRunIn.mockReset();
      mockAccountMayRunIn.mockResolvedValue(true);
      mockResolveProjectSavedOwner.mockReset();
      mockResolveProjectSavedOwner.mockResolvedValue({ kind: 'personal' });
      mockDecideSameOwnerAccess.mockReset();
      mockDecideSameOwnerAccess.mockResolvedValue({ kind: 'allowed' });
    });

    function textContaining(text: string): unknown {
      return expect.stringContaining(text);
    }

    function executedOptions(): Parameters<ExecutePipelineFn>[1] {
      const options = mockExecutePipeline.mock.calls[0]?.[1];
      if (!options) throw new Error('Expected a pipeline execution');
      return options;
    }

    type StartArgs = Parameters<typeof startPipelineExecutionFromMain>[0];
    const RUN_PIPELINE: StartArgs['pipeline'] = {
      name: 'Run',
      on: 'dispatch',
      jobs: {},
    };
    const GLOBAL_RUN_PIPELINE: StartArgs['pipeline'] = {
      name: 'Run',
      on: 'dispatch',
      scope: ['global'],
      jobs: {},
    };

    async function start(
      options: StartArgs['options'],
      pipeline: StartArgs['pipeline'] = options.scope === 'global'
        ? GLOBAL_RUN_PIPELINE
        : RUN_PIPELINE,
    ): ReturnType<typeof startPipelineExecutionFromMain> {
      return startPipelineExecutionFromMain({
        pipeline,
        options,
        getWindow: () => null,
      });
    }

    describe('pipeline assets', () => {
      function assetPipeline(assetPath: string): Pipeline {
        return {
          name: 'Assets',
          on: 'dispatch',
          assets: [{ id: 'specialists', path: assetPath }],
          jobs: {},
        };
      }

      it('fails the start before any step when a required asset is missing', async () => {
        mockLocalUserPipelineIds.add('asset-user');
        const result = await startPipelineExecutionFromMain({
          pipeline: assetPipeline(path.join(repoPath, 'missing-specialists')),
          options: { cwd: repoPath, pipelineId: 'asset-user' },
          getWindow: () => null,
        });
        expect(result).toMatchObject({
          success: false,
          error: textContaining('"specialists"'),
        });
        expect(mockExecutePipeline).not.toHaveBeenCalled();
      });

      it('passes resolved assets and a created data dir to the executor', async () => {
        mockLocalUserPipelineIds.add('asset-user');
        const specialists = path.join(repoPath, 'specialists');
        fs.mkdirSync(specialists, { recursive: true });
        await expect(
          startPipelineExecutionFromMain({
            pipeline: assetPipeline(specialists),
            options: { cwd: repoPath, pipelineId: 'asset-user' },
            getWindow: () => null,
          }),
        ).resolves.toMatchObject({ success: true });
        const dataDir = getPipelineDataDir('asset-user');
        expect(executedOptions()).toMatchObject({
          assetPaths: { specialists },
          pipelineDataDir: dataDir,
        });
        expect(executedOptions().assetsDir).toBeUndefined();
        expect(fs.statSync(dataDir).isDirectory()).toBe(true);
      });
    });

    it('records a Personal owner and a user initiator with the flag off', async () => {
      await expect(
        start({
          cwd: repoPath,
          projectId: 'project-1',
          worktreeId: 'worktree-1',
          pipelineId: 'run',
        }),
      ).resolves.toMatchObject({ success: true });
      expect(executedOptions()).toMatchObject({
        executionContext: 'personal',
        initiator: { kind: 'user' },
      });
      expect(mockResolveProjectSavedOwner).not.toHaveBeenCalled();
    });

    it("records the project's saved owner for a flag-on Personal foreground run", async () => {
      mockBackgroundEnabled.mockReturnValue(true);
      mockCaptureBackgroundContext.mockResolvedValue('personal');

      await expect(
        start({
          cwd: repoPath,
          projectId: 'project-1',
          worktreeId: 'worktree-1',
          pipelineId: 'run',
          initiationSource: 'user',
        }),
      ).resolves.toMatchObject({ success: true });
      expect(mockResolveProjectSavedOwner).toHaveBeenCalledWith({
        projectId: 'project-1',
        worktreeId: 'worktree-1',
      });
      expect(executedOptions()).toMatchObject({ executionContext: 'personal' });
      expect(mockAuthorizeBackground).not.toHaveBeenCalled();
    });

    it('authorizes a derived organization owner and refuses an account outside it', async () => {
      mockBackgroundEnabled.mockReturnValue(true);
      mockCaptureBackgroundContext.mockResolvedValue('personal');
      mockResolveProjectSavedOwner.mockResolvedValue({
        kind: 'organization',
        organizationId: 'bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb',
      });
      const options = {
        cwd: repoPath,
        projectId: 'project-1',
        worktreeId: 'worktree-1',
        pipelineId: 'run',
        initiationSource: 'user' as const,
      };

      await expect(start(options)).resolves.toMatchObject({ success: true });
      expect(mockAuthorizeBackground).toHaveBeenCalledWith(
        ORG_B,
        expect.any(Array),
        { projectId: 'project-1', worktreeId: 'worktree-1' },
      );
      expect(executedOptions()).toMatchObject({
        executionContext: ORG_B,
        allowUnverifiedForegroundChildren: true,
      });

      mockExecutePipeline.mockClear();
      mockAccountMayRunIn.mockResolvedValue(false);
      await expect(start(options)).resolves.toMatchObject({
        success: false,
        error: textContaining('no longer have access'),
      });
      expect(mockExecutePipeline).not.toHaveBeenCalled();
    });

    it("refuses a run whose project's owner can't be read", async () => {
      mockBackgroundEnabled.mockReturnValue(true);
      mockCaptureBackgroundContext.mockResolvedValue('personal');
      mockResolveProjectSavedOwner.mockResolvedValue({ kind: 'unknown' });

      await expect(
        start({
          cwd: repoPath,
          projectId: 'project-1',
          worktreeId: 'worktree-1',
          pipelineId: 'run',
        }),
      ).resolves.toMatchObject({
        success: false,
        error: textContaining("Couldn't confirm where"),
      });
      expect(mockExecutePipeline).not.toHaveBeenCalled();
    });

    it("keeps an explicit hook binding over the project's owner", async () => {
      mockBackgroundEnabled.mockReturnValue(true);
      mockCaptureBackgroundContext.mockResolvedValue('personal');
      mockResolveProjectSavedOwner.mockResolvedValue({ kind: 'personal' });

      await expect(
        start({
          cwd: repoPath,
          projectId: 'project-1',
          worktreeId: 'worktree-1',
          pipelineId: 'run',
          initiationSource: 'hook',
          initiator: { kind: 'hook' },
          executionContext: ORG_A,
        }),
      ).resolves.toMatchObject({ success: true });
      expect(mockResolveProjectSavedOwner).not.toHaveBeenCalled();
      expect(executedOptions()).toMatchObject({
        executionContext: ORG_A,
        initiator: { kind: 'hook' },
      });
    });

    it('runs a global request without cwd in its scratch folder', async () => {
      await expect(
        start({ scope: 'global', pipelineId: 'run' }),
      ).resolves.toMatchObject({ success: true });
      const options = executedOptions();
      expect(options.cwd).toBe(
        path.join(
          runtime.executionsDir,
          options.executionId ?? '',
          'workspace',
        ),
      );
    });

    it.each<[string, Partial<StartArgs['options']>]>([
      ['a working directory', { cwd: '/repo' }],
      ['a project root', { cwd: '/repo', repoPath: '/repo' }],
      ['a project', { projectId: 'project-1' }],
      ['a project and task', { projectId: 'project-1', worktreeId: 'task-1' }],
    ])(
      'refuses a global run naming %s before reserving it',
      async (_label, overrides) => {
        mockBackgroundEnabled.mockReturnValue(true);
        mockCaptureBackgroundContext.mockResolvedValue('personal');
        mockLocalUserPipelineIds.add('legacy');
        const tryReserve = jest.spyOn(
          pipelineExecutionRegistry,
          'tryReserveExecution',
        );
        try {
          await expect(
            start({
              scope: 'global',
              pipelineId: 'legacy',
              initiationSource: 'user',
              requestedOwner: ORG_B,
              ...overrides,
            }),
          ).resolves.toEqual({
            success: false,
            error: GLOBAL_RUN_TARGET_MESSAGE,
          });
          expect(tryReserve).not.toHaveBeenCalled();
        } finally {
          tryReserve.mockRestore();
        }
        expect(
          mockWithWorkspaceTargetRuntimeStartReservation,
        ).not.toHaveBeenCalled();
        expect(mockReservePipelineExecutionStart).not.toHaveBeenCalled();
        expect(mockExecutePipeline).not.toHaveBeenCalled();
        expect(mockAccountMayRunIn).not.toHaveBeenCalled();
        expect(mockRecordUserPipelineOwner).not.toHaveBeenCalled();
        expect(mockPipelineMetadata.get('legacy')).toBeUndefined();
      },
    );

    it('refuses a global project pipeline and a project run without cwd', async () => {
      await expect(
        start({
          scope: 'global',
          pipelineId: 'project--deploy.yaml',
          pipelineFilePath: path.join(pipelinesDir, 'deploy.yaml'),
        }),
      ).resolves.toMatchObject({
        success: false,
        error: GLOBAL_RUN_TARGET_MESSAGE,
      });
      await expect(
        start({
          projectId: 'project-1',
          worktreeId: 'worktree-1',
          pipelineId: 'run',
        }),
      ).resolves.toMatchObject({
        success: false,
        error: textContaining('unsupported-target'),
      });
      expect(mockExecutePipeline).not.toHaveBeenCalled();
    });

    it('authorizes a chosen organization owner on a foreground global run', async () => {
      mockBackgroundEnabled.mockReturnValue(true);
      mockCaptureBackgroundContext.mockResolvedValue('personal');
      const options = {
        scope: 'global' as const,
        pipelineId: 'run',
        initiationSource: 'user' as const,
        requestedOwner: ORG_B,
      };

      await expect(start(options)).resolves.toMatchObject({ success: true });
      expect(mockAccountMayRunIn).toHaveBeenCalledWith({
        kind: 'organization',
        organizationId: 'bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb',
      });
      expect(mockAuthorizeBackground).toHaveBeenCalledWith(
        ORG_B,
        expect.any(Array),
        { scope: 'global' },
      );
      expect(executedOptions()).toMatchObject({ executionContext: ORG_B });

      mockExecutePipeline.mockClear();
      mockAuthorizeBackground.mockClear();
      mockAccountMayRunIn.mockResolvedValue(false);
      await expect(start(options)).resolves.toMatchObject({
        success: false,
        error: textContaining('no longer have access'),
      });
      expect(mockAuthorizeBackground).not.toHaveBeenCalled();
      expect(mockExecutePipeline).not.toHaveBeenCalled();
    });

    it("uses a stored user pipeline's owner and agent marker on a global run", async () => {
      mockBackgroundEnabled.mockReturnValue(true);
      mockCaptureBackgroundContext.mockResolvedValue('personal');
      mockLocalUserPipelineIds.add('agent-written');
      mockPipelineMetadata.set('agent-written', {
        owner: 'personal',
        agentAuthor: { chat: AGENT_CHAT, recordedAt: 'now' },
      });

      await expect(
        start({ scope: 'global', pipelineId: 'agent-written' }),
      ).resolves.toMatchObject({ success: true });
      expect(executedOptions()).toMatchObject({
        executionContext: 'personal',
        initiator: { kind: 'user' },
        agentOrigin: AGENT_CHAT,
      });
    });

    it("keeps a global user pipeline's saved owner over a selected organization", async () => {
      mockBackgroundEnabled.mockReturnValue(true);
      mockCaptureBackgroundContext.mockResolvedValue(ORG_A);
      mockLocalUserPipelineIds.add('personal-owned');
      mockPipelineMetadata.set('personal-owned', { owner: 'personal' });

      await expect(
        start({
          scope: 'global',
          pipelineId: 'personal-owned',
          initiationSource: 'user',
        }),
      ).resolves.toMatchObject({ success: true });
      // A person's global run takes its saved owner, never the selected
      // organization (the foreground org dispatch binding is for project runs).
      expect(executedOptions()).toMatchObject({ executionContext: 'personal' });
      expect(mockAuthorizeBackground).not.toHaveBeenCalled();
      expect(mockRecordUserPipelineOwner).not.toHaveBeenCalled();
    });

    it('keeps a saved organization owner over a different selected organization', async () => {
      mockBackgroundEnabled.mockReturnValue(true);
      mockCaptureBackgroundContext.mockResolvedValue(ORG_A);
      mockLocalUserPipelineIds.add('org-owned');
      mockPipelineMetadata.set('org-owned', { owner: ORG_B });

      await expect(
        start({
          scope: 'global',
          pipelineId: 'org-owned',
          initiationSource: 'portal',
        }),
      ).resolves.toMatchObject({ success: true });
      expect(executedOptions()).toMatchObject({ executionContext: ORG_B });
      expect(mockAccountMayRunIn).toHaveBeenCalledWith({
        kind: 'organization',
        organizationId: 'bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb',
      });
      expect(mockAuthorizeBackground).toHaveBeenCalledWith(
        ORG_B,
        expect.any(Array),
        { scope: 'global' },
      );
      expect(mockAuthorizeBackground).not.toHaveBeenCalledWith(
        ORG_A,
        expect.anything(),
        expect.anything(),
      );
    });

    it("binds an unowned user pipeline to a person's chosen owner and records it on the run", async () => {
      mockBackgroundEnabled.mockReturnValue(true);
      mockCaptureBackgroundContext.mockResolvedValue('personal');
      mockLocalUserPipelineIds.add('legacy');

      await expect(
        start({
          scope: 'global',
          pipelineId: 'legacy',
          initiationSource: 'user',
          requestedOwner: ORG_B,
        }),
      ).resolves.toMatchObject({ success: true });
      expect(mockRecordUserPipelineOwner).toHaveBeenCalledTimes(1);
      expect(mockRecordUserPipelineOwner).toHaveBeenCalledWith('legacy', ORG_B);
      expect(mockPipelineMetadata.get('legacy')).toEqual({ owner: ORG_B });
      expect(executedOptions()).toMatchObject({
        executionContext: ORG_B,
        initiator: { kind: 'user' },
      });
      // The binding follows authorization.
      expect(mockAuthorizeBackground.mock.invocationCallOrder[0]).toBeLessThan(
        mockRecordUserPipelineOwner.mock.invocationCallOrder[0] ?? 0,
      );

      // The next run reads the binding and needs no choice.
      mockExecutePipeline.mockClear();
      await expect(
        start({
          scope: 'global',
          pipelineId: 'legacy',
          initiationSource: 'user',
        }),
      ).resolves.toMatchObject({ success: true });
      expect(executedOptions()).toMatchObject({ executionContext: ORG_B });
      expect(mockRecordUserPipelineOwner).toHaveBeenCalledTimes(1);
    });

    it('binds a Personal choice without organization authorization', async () => {
      mockBackgroundEnabled.mockReturnValue(true);
      mockCaptureBackgroundContext.mockResolvedValue(ORG_A);
      mockLocalUserPipelineIds.add('legacy');

      await expect(
        start({
          scope: 'global',
          pipelineId: 'legacy',
          initiationSource: 'user',
          requestedOwner: 'personal',
        }),
      ).resolves.toMatchObject({ success: true });
      expect(mockPipelineMetadata.get('legacy')).toEqual({ owner: 'personal' });
      expect(executedOptions()).toMatchObject({ executionContext: 'personal' });
      expect(mockAuthorizeBackground).not.toHaveBeenCalled();
    });

    it('returns a refusal, not a throw, when the owner check fails to read', async () => {
      mockBackgroundEnabled.mockReturnValue(true);
      mockCaptureBackgroundContext.mockRejectedValue(new Error('offline'));
      mockLocalUserPipelineIds.add('legacy');

      await expect(
        start({
          scope: 'global',
          pipelineId: 'legacy',
          initiationSource: 'user',
          requestedOwner: ORG_B,
        }),
      ).resolves.toEqual({
        success: false,
        error: GLOBAL_RUN_OWNER_CHECK_FAILED_MESSAGE,
      });
      expect(mockRecordUserPipelineOwner).not.toHaveBeenCalled();
      expect(mockExecutePipeline).not.toHaveBeenCalled();
    });

    it('does not bind an owner when authorization refuses the run', async () => {
      mockBackgroundEnabled.mockReturnValue(true);
      mockCaptureBackgroundContext.mockResolvedValue('personal');
      mockLocalUserPipelineIds.add('legacy');
      mockAuthorizeBackground.mockResolvedValue({
        allow: false,
        reason: 'access-removed',
      });

      await expect(
        start({
          scope: 'global',
          pipelineId: 'legacy',
          initiationSource: 'user',
          requestedOwner: ORG_B,
        }),
      ).resolves.toMatchObject({ success: false });
      expect(mockRecordUserPipelineOwner).not.toHaveBeenCalled();
      expect(mockPipelineMetadata.get('legacy')).toBeUndefined();
      expect(mockExecutePipeline).not.toHaveBeenCalled();
    });

    it('keeps the owner binding when the start fails after it', async () => {
      mockBackgroundEnabled.mockReturnValue(true);
      mockCaptureBackgroundContext.mockResolvedValue('personal');
      mockLocalUserPipelineIds.add('legacy');
      mockExecutePipeline.mockRejectedValueOnce(new Error('executor failed'));

      await expect(
        start({
          scope: 'global',
          pipelineId: 'legacy',
          initiationSource: 'user',
          requestedOwner: ORG_B,
        }),
      ).resolves.toMatchObject({ success: false });
      // Binding is an ownership decision, not a leftover of the failed start.
      expect(mockPipelineMetadata.get('legacy')).toEqual({ owner: ORG_B });

      mockExecutePipeline.mockClear();
      await expect(
        start({
          scope: 'global',
          pipelineId: 'legacy',
          initiationSource: 'user',
        }),
      ).resolves.toMatchObject({ success: true });
      expect(executedOptions()).toMatchObject({ executionContext: ORG_B });
      expect(mockRecordUserPipelineOwner).toHaveBeenCalledTimes(1);
    });

    it('gives concurrent global starts of one pipeline their own executions and folders', async () => {
      const [first, second] = await Promise.all([
        start({ scope: 'global', pipelineId: 'run' }),
        start({ scope: 'global', pipelineId: 'run' }),
      ]);
      expect(first).toMatchObject({ success: true });
      expect(second).toMatchObject({ success: true });
      const started = mockExecutePipeline.mock.calls.map((call) => call[1]);
      expect(started).toHaveLength(2);
      const [a, b] = started;
      expect(a?.executionId).toBeDefined();
      expect(a?.executionId).not.toBe(b?.executionId);
      expect(a?.cwd).not.toBe(b?.cwd);
      for (const options of started)
        expect(options.cwd).toBe(
          path.join(
            runtime.executionsDir,
            options.executionId ?? '',
            'workspace',
          ),
        );
    });

    it("refuses the run when a binding can't be confirmed", async () => {
      mockBackgroundEnabled.mockReturnValue(true);
      mockCaptureBackgroundContext.mockResolvedValue('personal');
      mockLocalUserPipelineIds.add('legacy');
      mockRecordUserPipelineOwner.mockImplementationOnce(() => undefined);

      await expect(
        start({
          scope: 'global',
          pipelineId: 'legacy',
          initiationSource: 'user',
          requestedOwner: 'personal',
        }),
      ).resolves.toMatchObject({
        success: false,
        error: textContaining("Couldn't confirm where"),
      });
      expect(mockExecutePipeline).not.toHaveBeenCalled();
    });

    it("authorizes a global run's stored pipeline against its owner, not the selected context", async () => {
      mockIsFeatureFlagEnabled.mockReturnValue(true);
      mockBackgroundEnabled.mockReturnValue(true);
      mockCaptureBackgroundContext.mockResolvedValue('personal');
      mockLocalUserPipelineIds.add('owned');
      mockPipelineMetadata.set('owned', { owner: ORG_A });
      const resource = {
        owner: { type: 'user' as const, id: 'me', name: null },
      };
      const stored = jest
        .spyOn(pipelineInstallContext, 'assertStoredPipelineContext')
        .mockResolvedValue();
      const read = jest
        .spyOn(pipelineInstallContext, 'readStoredPipelineContext')
        .mockResolvedValue(resource);
      const authorize = jest
        .spyOn(pipelineResourceLanes, 'assertPipelineContext')
        .mockResolvedValue();
      const snapshot = jest
        .spyOn(pipelineResourceLanes, 'pipelineContextSnapshot')
        .mockResolvedValue('snapshot');
      const snapshotCheck = jest
        .spyOn(pipelineResourceLanes, 'assertPipelineContextSnapshot')
        .mockResolvedValue();
      try {
        await expect(
          start({
            scope: 'global',
            pipelineId: 'owned',
            initiationSource: 'user',
          }),
        ).resolves.toMatchObject({ success: true });
        expect(stored).not.toHaveBeenCalled();
        expect(read).toHaveBeenCalledWith('owned', ORG_A);
        expect(authorize).toHaveBeenCalledWith(resource, undefined, ORG_A);

        // A definition outside the owner is refused before anything starts.
        authorize.mockRejectedValueOnce(
          new Error('Workflow unavailable (context-mismatch)'),
        );
        mockExecutePipeline.mockClear();
        await expect(
          start({
            scope: 'global',
            pipelineId: 'owned',
            initiationSource: 'user',
          }),
        ).resolves.toMatchObject({ success: false });
        expect(mockExecutePipeline).not.toHaveBeenCalled();
      } finally {
        stored.mockRestore();
        read.mockRestore();
        authorize.mockRestore();
        snapshot.mockRestore();
        snapshotCheck.mockRestore();
      }
    });

    it("authorizes a global run's shared definition against its owner, not the selected context", async () => {
      mockIsFeatureFlagEnabled.mockReturnValue(true);
      mockBackgroundEnabled.mockReturnValue(true);
      mockCaptureBackgroundContext.mockResolvedValue('personal');
      const detail = createSharedPipelineDetail({ id: 'remote-global' });
      mockedGetSharedPipeline.mockClear();
      mockedGetSharedPipelineForExecutionContext.mockResolvedValueOnce(detail);
      const authorize = jest
        .spyOn(pipelineResourceLanes, 'assertPipelineContext')
        .mockResolvedValue();
      const snapshot = jest
        .spyOn(pipelineResourceLanes, 'pipelineContextSnapshot')
        .mockResolvedValue('snapshot');
      const snapshotCheck = jest
        .spyOn(pipelineResourceLanes, 'assertPipelineContextSnapshot')
        .mockResolvedValue();
      try {
        await expect(
          start({
            scope: 'global',
            pipelineId: 'shared:canopy-cloud:remote-global',
            sharedPipeline: {
              serverId: 'canopy-cloud',
              remoteId: 'remote-global',
            },
            initiationSource: 'user',
            requestedOwner: ORG_B,
          }),
        ).resolves.toMatchObject({ success: true });
        // Never the navigation-scoped read or check.
        expect(mockedGetSharedPipeline).not.toHaveBeenCalled();
        expect(authorize).toHaveBeenCalledWith(
          { owner: detail.owner },
          undefined,
          ORG_B,
        );
        for (const call of authorize.mock.calls) expect(call[2]).toBe(ORG_B);
        expect(executedOptions()).toMatchObject({ executionContext: ORG_B });
      } finally {
        authorize.mockRestore();
        snapshot.mockRestore();
        snapshotCheck.mockRestore();
      }
    });

    it("doesn't bind an owner when saved owners became unreadable during authorization", async () => {
      mockBackgroundEnabled.mockReturnValue(true);
      mockCaptureBackgroundContext.mockResolvedValue('personal');
      mockLocalUserPipelineIds.add('legacy');
      mockAuthorizeBackground.mockImplementationOnce(() => {
        mockPipelineMetadataReadable = false;
        return Promise.resolve({ allow: true });
      });

      await expect(
        start({
          scope: 'global',
          pipelineId: 'legacy',
          initiationSource: 'user',
          requestedOwner: ORG_B,
        }),
      ).resolves.toEqual({
        success: false,
        error: textContaining("Couldn't confirm where"),
      });
      expect(mockRecordUserPipelineOwner).not.toHaveBeenCalled();
      expect(mockExecutePipeline).not.toHaveBeenCalled();
    });

    it('refuses a chosen owner when another start binds the pipeline while it is authorized', async () => {
      mockBackgroundEnabled.mockReturnValue(true);
      mockCaptureBackgroundContext.mockResolvedValue('personal');
      mockLocalUserPipelineIds.add('legacy');
      let releaseAuthorization: () => void = () => undefined;
      mockAuthorizeBackground.mockImplementationOnce(
        () =>
          new Promise((resolve) => {
            releaseAuthorization = (): void => resolve({ allow: true });
          }),
      );

      // The organization start reads the pipeline unowned, then waits on
      // authorization while a Personal start binds it.
      const organizationStart = start({
        scope: 'global',
        pipelineId: 'legacy',
        initiationSource: 'user',
        requestedOwner: ORG_B,
      });
      while (mockAuthorizeBackground.mock.calls.length === 0)
        await new Promise((resolve) => setImmediate(resolve));
      await expect(
        start({
          scope: 'global',
          pipelineId: 'legacy',
          initiationSource: 'user',
          requestedOwner: 'personal',
        }),
      ).resolves.toMatchObject({ success: true });
      releaseAuthorization();

      await expect(organizationStart).resolves.toEqual({
        success: false,
        error: PIPELINE_NOW_OWNED_MESSAGE,
        errorCode: 'pipeline_now_owned',
      });
      expect(mockRecordUserPipelineOwner).toHaveBeenCalledTimes(1);
      expect(mockPipelineMetadata.get('legacy')).toEqual({ owner: 'personal' });
      expect(mockExecutePipeline).toHaveBeenCalledTimes(1);
    });

    it('asks a person to choose an owner for an unowned global pipeline', async () => {
      mockBackgroundEnabled.mockReturnValue(true);
      mockCaptureBackgroundContext.mockResolvedValue(ORG_A);
      mockLocalUserPipelineIds.add('legacy');

      await expect(
        start({
          scope: 'global',
          pipelineId: 'legacy',
          initiationSource: 'user',
        }),
      ).resolves.toEqual({ success: false, error: CHOOSE_RUN_OWNER_MESSAGE });
      expect(mockRecordUserPipelineOwner).not.toHaveBeenCalled();
      expect(mockExecutePipeline).not.toHaveBeenCalled();
    });

    it('refuses a stale chosen owner after the pipeline became owned, without rewriting it', async () => {
      mockBackgroundEnabled.mockReturnValue(true);
      mockCaptureBackgroundContext.mockResolvedValue('personal');
      mockLocalUserPipelineIds.add('legacy');
      // Another start bound the pipeline after this dialog read it unowned.
      mockPipelineMetadata.set('legacy', { owner: ORG_A });

      await expect(
        start({
          scope: 'global',
          pipelineId: 'legacy',
          initiationSource: 'user',
          requestedOwner: ORG_B,
        }),
      ).resolves.toEqual({
        success: false,
        error: PIPELINE_NOW_OWNED_MESSAGE,
        errorCode: 'pipeline_now_owned',
      });
      expect(mockRecordUserPipelineOwner).not.toHaveBeenCalled();
      expect(mockPipelineMetadata.get('legacy')).toEqual({ owner: ORG_A });
      expect(mockReservePipelineExecutionStart).not.toHaveBeenCalled();
      expect(mockExecutePipeline).not.toHaveBeenCalled();
    });

    it("refuses a person's global run while saved owners can't be read", async () => {
      mockBackgroundEnabled.mockReturnValue(true);
      mockCaptureBackgroundContext.mockResolvedValue('personal');
      mockLocalUserPipelineIds.add('legacy');
      mockPipelineMetadataReadable = false;

      await expect(
        start({
          scope: 'global',
          pipelineId: 'legacy',
          initiationSource: 'user',
          requestedOwner: 'personal',
        }),
      ).resolves.toMatchObject({
        success: false,
        error: textContaining("Couldn't confirm where"),
      });
      expect(mockRecordUserPipelineOwner).not.toHaveBeenCalled();
      expect(mockExecutePipeline).not.toHaveBeenCalled();
    });

    it('keeps only a valid chosen owner from the renderer and drops forged identity', async () => {
      mockBackgroundEnabled.mockReturnValue(true);
      mockCaptureBackgroundContext.mockResolvedValue(ORG_A);
      const handler = getHandler(PIPELINE_CHANNELS.EXECUTE);
      const forged = {
        pipelineId: 'run',
        scope: 'global',
        executionContext: ORG_A,
        initiator: { kind: 'agent', chat: AGENT_CHAT },
        agentOrigin: AGENT_CHAT,
        executionId: 'forged-execution-id',
        allowUnverifiedForegroundChildren: true,
      };

      await expect(
        handler(undefined, GLOBAL_RUN_PIPELINE, {
          ...forged,
          requestedOwner: 'personal',
        }),
      ).resolves.toMatchObject({ success: true });
      const options = executedOptions();
      expect(options.executionContext).toBe('personal');
      expect(options.initiator).toEqual({ kind: 'user' });
      expect(options.agentOrigin).toBeUndefined();
      expect(options.executionId).not.toBe('forged-execution-id');
      expect(options).not.toHaveProperty('allowUnverifiedForegroundChildren');
      expect(options).not.toHaveProperty('requestedOwner');
      expect(mockAuthorizeBackground).not.toHaveBeenCalled();

      // A malformed owner is dropped, so the person is asked to choose.
      mockExecutePipeline.mockClear();
      await expect(
        handler(undefined, GLOBAL_RUN_PIPELINE, {
          ...forged,
          requestedOwner: 'org:not-a-uuid',
        }),
      ).resolves.toEqual({ success: false, error: CHOOSE_RUN_OWNER_MESSAGE });
      expect(mockExecutePipeline).not.toHaveBeenCalled();
    });

    it("treats a renderer global start claiming App Advisor as a person's", async () => {
      mockBackgroundEnabled.mockReturnValue(true);
      mockCaptureBackgroundContext.mockResolvedValue(ORG_A);
      mockLocalUserPipelineIds.add('legacy');
      const handler = getHandler(PIPELINE_CHANNELS.EXECUTE);

      // App Advisor's global runs start in main, never from the renderer.
      await expect(
        handler(undefined, GLOBAL_RUN_PIPELINE, {
          pipelineId: 'legacy',
          scope: 'global',
          initiationSource: 'app_advisor',
        }),
      ).resolves.toEqual({ success: false, error: CHOOSE_RUN_OWNER_MESSAGE });
      expect(mockRecordUserPipelineOwner).not.toHaveBeenCalled();
      expect(mockExecutePipeline).not.toHaveBeenCalled();

      await expect(
        handler(undefined, GLOBAL_RUN_PIPELINE, {
          pipelineId: 'legacy',
          scope: 'global',
          initiationSource: 'app_advisor',
          requestedOwner: 'personal',
        }),
      ).resolves.toMatchObject({ success: true });
      expect(executedOptions().initiator).toEqual({ kind: 'user' });
    });

    describe('single-pipeline read owner', () => {
      beforeEach(() => {
        mockBackgroundEnabled.mockReturnValue(true);
      });

      function pipelineData(
        id: string,
        source: 'user' | 'bundled',
      ): ReturnType<typeof pipelineService.getPipeline> {
        return {
          success: true,
          data: {
            info: {
              id,
              name: id,
              description: '',
              icon: '',
              source,
              readonly: source === 'bundled',
              filename: `${id}.yaml`,
              createdAt: '2026-03-27T12:00:00.000Z',
              updatedAt: '2026-03-27T12:00:00.000Z',
            },
            content: { name: id, on: 'dispatch', jobs: {} },
          },
        };
      }

      it('annotates a user pipeline with its saved owner', async () => {
        mockPipelineMetadata.set('owned', { owner: ORG_B });
        jest
          .mocked(pipelineService.getPipeline)
          .mockReturnValue(pipelineData('owned', 'user'));
        mockedGetStoredPipelineBySource.mockReturnValue(
          pipelineData('owned', 'user'),
        );

        await expect(
          getHandler(PIPELINE_CHANNELS.GET)(undefined, 'owned'),
        ).resolves.toMatchObject({
          success: true,
          data: { info: { id: 'owned' }, localRunOwner: ORG_B },
        });
        await expect(
          getHandler(PIPELINE_CHANNELS.GET)(undefined, {
            source: 'user',
            id: 'owned',
          }),
        ).resolves.toMatchObject({
          success: true,
          data: { localRunOwner: ORG_B },
        });
        expect(mockRecordUserPipelineOwner).not.toHaveBeenCalled();
      });

      it('leaves unowned and bundled pipelines unannotated', async () => {
        mockPipelineMetadata.set('bundled', { owner: ORG_B });
        jest
          .mocked(pipelineService.getPipeline)
          .mockReturnValueOnce(pipelineData('legacy', 'user'))
          .mockReturnValueOnce(pipelineData('bundled', 'bundled'));

        const legacy = await getHandler(PIPELINE_CHANNELS.GET)(
          undefined,
          'legacy',
        );
        expect(legacy).toMatchObject({ success: true });
        expect(legacy).not.toHaveProperty('data.localRunOwner');
        const bundled = await getHandler(PIPELINE_CHANNELS.GET)(
          undefined,
          'bundled',
        );
        expect(bundled).toMatchObject({ success: true });
        expect(bundled).not.toHaveProperty('data.localRunOwner');
        // Reading never binds a legacy pipeline.
        expect(mockRecordUserPipelineOwner).not.toHaveBeenCalled();
      });

      it("marks a user pipeline's owner unreadable instead of failing the read", async () => {
        mockPipelineMetadataReadable = false;
        mockPipelineMetadata.set('owned', { owner: ORG_B });
        jest
          .mocked(pipelineService.getPipeline)
          .mockReturnValue(pipelineData('owned', 'user'));
        mockedGetStoredPipelineBySource.mockReturnValue(
          pipelineData('owned', 'user'),
        );

        // The editor and other reads keep working; the pipeline never
        // appears unowned, and the Run dialog blocks a run with no project.
        for (const request of ['owned', { source: 'user', id: 'owned' }]) {
          const read = await getHandler(PIPELINE_CHANNELS.GET)(
            undefined,
            request,
          );
          expect(read).toMatchObject({
            success: true,
            data: { localRunOwnerUnreadable: true },
          });
          expect(read).not.toHaveProperty('data.localRunOwner');
        }
      });

      it('neither annotates nor fails a read with organization projects off', async () => {
        // Every run is Personal then, so the saved owner is never used.
        mockBackgroundEnabled.mockReturnValue(false);
        mockPipelineMetadataReadable = false;
        mockPipelineMetadata.set('owned', { owner: ORG_B });
        jest
          .mocked(pipelineService.getPipeline)
          .mockReturnValue(pipelineData('owned', 'user'));

        const read = await getHandler(PIPELINE_CHANNELS.GET)(
          undefined,
          'owned',
        );
        expect(read).toMatchObject({ success: true });
        expect(read).not.toHaveProperty('data.localRunOwner');
      });

      it('passes through a failed read and a bundled read while owners are unreadable', async () => {
        mockPipelineMetadataReadable = false;
        jest
          .mocked(pipelineService.getPipeline)
          .mockReturnValueOnce({ success: false, error: 'Pipeline not found' })
          .mockReturnValueOnce(pipelineData('bundled', 'bundled'));

        await expect(
          getHandler(PIPELINE_CHANNELS.GET)(undefined, 'missing'),
        ).resolves.toEqual({ success: false, error: 'Pipeline not found' });
        await expect(
          getHandler(PIPELINE_CHANNELS.GET)(undefined, 'bundled'),
        ).resolves.toMatchObject({ success: true });
      });
    });

    it('refuses an organization choice with organization projects off', async () => {
      mockLocalUserPipelineIds.add('legacy');
      await expect(
        getHandler(PIPELINE_CHANNELS.EXECUTE)(undefined, GLOBAL_RUN_PIPELINE, {
          pipelineId: 'legacy',
          scope: 'global',
          requestedOwner: ORG_B,
        }),
      ).resolves.toEqual({
        success: false,
        error: RUN_OWNER_UNAVAILABLE_MESSAGE,
      });
      expect(mockRecordUserPipelineOwner).not.toHaveBeenCalled();
      expect(mockExecutePipeline).not.toHaveBeenCalled();
    });

    it("authorizes an automation run with no project and its children against the automation's owner", async () => {
      mockBackgroundEnabled.mockReturnValue(true);
      mockCaptureBackgroundContext.mockResolvedValue('personal');
      const record = {
        request: 'child',
        identity: 'local',
        contentHash: 'a'.repeat(64),
      };
      mockAuthorizeBackground.mockImplementation(
        (_context, _resources, _destination, records) => {
          records?.push(record);
          return Promise.resolve({ allow: true });
        },
      );
      const options = {
        scope: 'global' as const,
        pipelineId: 'run',
        initiationSource: 'automation' as const,
        initiator: {
          kind: 'automation' as const,
          automationId: 'automation-1',
          automationName: 'Nightly',
        },
        executionContext: ORG_B,
      };

      await expect(start(options)).resolves.toMatchObject({ success: true });
      expect(mockAuthorizeBackground).toHaveBeenCalledWith(
        ORG_B,
        expect.any(Array),
        { scope: 'global' },
        [record],
      );
      expect(executedOptions()).toMatchObject({
        executionContext: ORG_B,
        childPipelineAuthorizations: [record],
      });
      expect(executedOptions()).not.toHaveProperty(
        'allowUnverifiedForegroundChildren',
      );

      mockExecutePipeline.mockClear();
      mockAuthorizeBackground.mockResolvedValue({
        allow: false,
        reason: 'access-removed',
      });
      await expect(start(options)).resolves.toMatchObject({
        success: false,
        error: backgroundExecutionDeniedMessage('access-removed'),
      });
      expect(mockExecutePipeline).not.toHaveBeenCalled();
    });

    it("checks a stored pipeline in an automation run with no project as the automation's owner", async () => {
      mockIsFeatureFlagEnabled.mockReturnValue(true);
      mockBackgroundEnabled.mockReturnValue(true);
      mockCaptureBackgroundContext.mockResolvedValue('personal');
      mockAuthorizeBackground.mockResolvedValue({ allow: true });
      const stored = jest
        .spyOn(pipelineInstallContext, 'assertStoredPipelineContext')
        .mockResolvedValue();
      const definition = { owner: { type: 'system' as const } };
      const resource = jest
        .spyOn(pipelineInstallContext, 'readStoredPipelineContext')
        .mockResolvedValue(definition);
      const authorize = jest
        .spyOn(pipelineResourceLanes, 'assertPipelineContext')
        .mockResolvedValue();
      const snapshot = jest
        .spyOn(pipelineResourceLanes, 'pipelineContextSnapshot')
        .mockResolvedValue('current');
      const fence = jest
        .spyOn(pipelineResourceLanes, 'assertPipelineContextSnapshot')
        .mockResolvedValue(undefined);
      try {
        await expect(
          start({
            scope: 'global',
            pipelineId: 'run',
            initiationSource: 'automation',
            initiator: {
              kind: 'automation',
              automationId: 'automation-1',
              automationName: 'Nightly',
            },
            executionContext: ORG_B,
          }),
        ).resolves.toMatchObject({ success: true });
        // Checked once against the automation's owner, never navigation.
        expect(stored).not.toHaveBeenCalled();
        expect(resource).toHaveBeenCalledWith('run', ORG_B);
        expect(authorize).toHaveBeenCalledWith(definition, undefined, ORG_B);
      } finally {
        stored.mockRestore();
        resource.mockRestore();
        authorize.mockRestore();
        snapshot.mockRestore();
        fence.mockRestore();
      }
    });

    it('authorizes a shared pipeline in an automation run with no project', async () => {
      mockBackgroundEnabled.mockReturnValue(true);
      mockCaptureBackgroundContext.mockResolvedValue('personal');
      mockAuthorizeBackground.mockResolvedValue({ allow: true });
      mockedGetSharedPipeline.mockResolvedValue(
        createSharedPipelineDetail({ id: 'remote-exec' }),
      );

      await expect(
        start({
          scope: 'global',
          pipelineId: 'shared:canopy-cloud:remote-exec',
          initiationSource: 'automation',
          initiator: {
            kind: 'automation',
            automationId: 'automation-1',
            automationName: 'Nightly',
          },
          executionContext: ORG_B,
          sharedPipeline: { serverId: 'canopy-cloud', remoteId: 'remote-exec' },
        }),
      ).resolves.toMatchObject({ success: true });
      expect(mockAuthorizeBackground).toHaveBeenCalledWith(
        ORG_B,
        expect.any(Array),
        { scope: 'global' },
        [],
      );
      expect(executedOptions()).toMatchObject({ executionContext: ORG_B });
    });

    it('keeps an agent initiator and takes its chat as the agent origin', async () => {
      await start({
        cwd: repoPath,
        projectId: 'project-1',
        worktreeId: 'worktree-1',
        pipelineId: 'run',
        initiationSource: 'app_advisor',
        initiator: { kind: 'agent', chat: AGENT_CHAT },
      });
      expect(executedOptions()).toMatchObject({
        initiator: { kind: 'agent', chat: AGENT_CHAT },
        agentOrigin: AGENT_CHAT,
      });
    });

    it('records an automation run without an initiator as user and warns', async () => {
      const warn = jest
        .spyOn(mainProcessLogging, 'logMainProcessWarn')
        .mockImplementation(() => undefined);
      try {
        await start({
          cwd: repoPath,
          projectId: 'project-1',
          worktreeId: 'worktree-1',
          pipelineId: 'run',
          initiationSource: 'automation',
        });
        expect(executedOptions()).toMatchObject({
          initiator: { kind: 'user' },
        });
        expect(warn).toHaveBeenCalledWith(
          textContaining('without an initiator'),
        );
      } finally {
        warn.mockRestore();
      }
    });

    it.each([
      [undefined, { kind: 'user' }],
      ['app_advisor', { kind: 'app_advisor' }],
    ] as const)(
      'records the renderer initiator for source %s and never trusts a claimed one',
      async (initiationSource, initiator) => {
        const handler = registeredHandlers.get(PIPELINE_CHANNELS.EXECUTE);
        await handler?.(
          {},
          { name: 'Run', on: 'dispatch', jobs: {} },
          {
            cwd: repoPath,
            pipelineId: 'run',
            projectId: 'project-1',
            worktreeId: 'worktree-1',
            ...(initiationSource ? { initiationSource } : {}),
            initiator: { kind: 'agent', chat: AGENT_CHAT },
            agentOrigin: AGENT_CHAT,
            executionContext: ORG_A,
          },
        );
        const options = executedOptions();
        expect(options.initiator).toEqual(initiator);
        expect(options.agentOrigin).toBeUndefined();
        expect(options.executionContext).toBe('personal');
      },
    );

    it.each(['hook', 'automation', 'unknown'] as const)(
      'treats a renderer run claiming %s as foreground and authorizes its derived owner',
      async (initiationSource) => {
        mockBackgroundEnabled.mockReturnValue(true);
        mockCaptureBackgroundContext.mockResolvedValue('personal');
        mockResolveProjectSavedOwner.mockResolvedValue({
          kind: 'organization',
          organizationId: 'bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb',
        });
        const handler = registeredHandlers.get(PIPELINE_CHANNELS.EXECUTE);
        await handler?.(
          {},
          { name: 'Run', on: 'dispatch', jobs: {} },
          {
            cwd: repoPath,
            pipelineId: 'run',
            projectId: 'project-1',
            worktreeId: 'worktree-1',
            initiationSource,
          },
        );
        expect(mockAuthorizeBackground).toHaveBeenCalledWith(
          ORG_B,
          expect.any(Array),
          { projectId: 'project-1', worktreeId: 'worktree-1' },
        );
        const options = executedOptions();
        expect(options.initiationSource).toBeUndefined();
        expect(options).toMatchObject({
          executionContext: ORG_B,
          initiator: { kind: 'user' },
        });
      },
    );

    describe('pipeline writes', () => {
      const GLOBAL_CONTENT = {
        name: 'Global',
        on: 'dispatch' as const,
        scope: ['global' as const],
        jobs: {
          build: {
            steps: [
              {
                id: 'child',
                uses: 'builtin/run-pipeline',
                target: {
                  scope: 'worktree' as const,
                  workspace_id: 'project-b',
                  worktree: { id: 'task-b' },
                },
                with: { pipeline: 'child' },
              },
            ],
          },
        },
      };

      it('refuses a SAVE with a literal target another owner holds', async () => {
        mockDecideSameOwnerAccess.mockResolvedValue({ kind: 'hidden' });
        mockedSavePipeline.mockClear();

        const result = await getHandler(PIPELINE_CHANNELS.SAVE)(undefined, {
          name: 'Global',
          description: '',
          icon: '',
          content: GLOBAL_CONTENT,
        });

        expect(result).toEqual({
          success: false,
          error: "Project `project-b` isn't available to this pipeline",
        });
        expect(mockedSavePipeline).not.toHaveBeenCalled();
      });

      it('records the owner on create and clears the marker on update', async () => {
        mockBackgroundEnabled.mockReturnValue(true);
        mockCaptureBackgroundContext.mockResolvedValue(ORG_A);

        await getHandler(PIPELINE_CHANNELS.SAVE)(undefined, {
          name: 'Created',
          description: '',
          icon: '',
          content: { name: 'Created', on: 'dispatch', jobs: {} },
        });
        expect(mockPipelineMetadata.get('copy-id')).toEqual({ owner: ORG_A });

        mockLocalUserPipelineIds.add('copy-id');
        mockPipelineMetadata.set('copy-id', {
          owner: ORG_A,
          agentAuthor: { chat: AGENT_CHAT, recordedAt: 'now' },
        });
        mockCaptureBackgroundContext.mockResolvedValue('personal');
        await getHandler(PIPELINE_CHANNELS.SAVE)(undefined, {
          id: 'copy-id',
          name: 'Edited',
          description: '',
          icon: '',
          content: { name: 'Edited', on: 'dispatch', jobs: {} },
        });
        expect(mockPipelineMetadata.get('copy-id')).toEqual({ owner: ORG_A });
      });

      it('records the owner when a SAVE id is not yet a local user pipeline', async () => {
        mockBackgroundEnabled.mockReturnValue(true);
        mockCaptureBackgroundContext.mockResolvedValue(ORG_A);
        mockLocalUserPipelineIds.delete('copy-id');
        mockPipelineMetadata.delete('copy-id');

        await getHandler(PIPELINE_CHANNELS.SAVE)(undefined, {
          id: 'copy-id',
          name: 'Created',
          description: '',
          icon: '',
          content: { name: 'Created', on: 'dispatch', jobs: {} },
        });
        expect(mockPipelineMetadata.get('copy-id')).toEqual({ owner: ORG_A });
      });

      it('records the selected owner for a DUPLICATE copy', async () => {
        mockBackgroundEnabled.mockReturnValue(true);
        mockCaptureBackgroundContext.mockResolvedValue(ORG_A);
        jest.mocked(pipelineService.duplicatePipeline).mockReturnValue({
          success: true,
          data: {
            id: 'duplicate-id',
            name: 'Copy',
            description: '',
            icon: '',
            filename: 'duplicate-id.yaml',
            createdAt: '',
            updatedAt: '',
            source: 'user',
            readonly: false,
          },
        });

        await getHandler(PIPELINE_CHANNELS.DUPLICATE)(undefined, 'source-id');

        expect(mockPipelineMetadata.get('duplicate-id')).toEqual({
          owner: ORG_A,
        });
      });

      it('removes local metadata on DELETE', async () => {
        mockPipelineMetadata.set('deleted-id', { owner: 'personal' });
        jest
          .mocked(pipelineService.deletePipeline)
          .mockReturnValue({ success: true, data: undefined });

        await getHandler(PIPELINE_CHANNELS.DELETE)(undefined, 'deleted-id');

        expect(mockPipelineMetadata.has('deleted-id')).toBe(false);
      });
    });
  });

  it.each([
    [true, 'repository'],
    [false, 'repository'],
    [true, 'worktree'],
    [false, 'worktree'],
    [false, 'symlink'],
  ] as const)(
    'authorizes project duplication before Personal export (organization=%s, location=%s)',
    async (organization, location): Promise<void> => {
      mockIsFeatureFlagEnabled.mockReturnValue(true);
      mockResolveWorktreeCwd.mockReturnValue(repoPath);
      jest.mocked(readAllSidebarItems).mockResolvedValue({
        version: 1,
        items: [
          {
            type: 'single-repo',
            id: 'project-a',
            name: 'Project',
            repoPath: location === 'worktree' ? tempDir : repoPath,
            worktrees:
              location === 'worktree'
                ? [
                    {
                      id: 'worktree-a',
                      branchName: 'main',
                      createdAt: '2026-09-24T00:00:00Z',
                    },
                  ]
                : [],
            color: '',
            collapsed: false,
            order: 0,
          },
        ],
      });
      jest
        .mocked(workspacePersistence.readWorkspaceConfigDetailed)
        .mockResolvedValue({
          authority: 'ok',
          ownerMalformed: false,
          memoryMalformed: false,
          config: {
            version: 1,
            type: 'single-repo',
            repos: [],
            repoPath,
            ...(organization
              ? { owner: sparseWorkspaceOwnerBinding('org-a') }
              : {}),
          },
        });
      const policy = jest
        .spyOn(pipelineResourceLanes, 'assertPipelineContext')
        .mockResolvedValue();
      const stored = jest
        .spyOn(pipelineInstallContext, 'assertStoredPipelineContext')
        .mockResolvedValue();
      if (location === 'symlink') {
        const foreignRoot = path.join(tempDir, 'foreign-pipelines');
        fs.mkdirSync(foreignRoot);
        fs.rmdirSync(pipelinesDir);
        fs.symlinkSync(foreignRoot, pipelinesDir);
      }
      const pipelinePath = path.join(pipelinesDir, 'deploy.yaml');
      fs.writeFileSync(pipelinePath, 'name: Deploy\non: dispatch\njobs: {}');
      try {
        const result = await getHandler(PIPELINE_CHANNELS.DUPLICATE)(
          undefined,
          {
            id: 'project--deploy.yaml',
            cwd: repoPath,
            filePath: pipelinePath,
          },
        );
        if (location === 'symlink') {
          expect(result).toEqual({
            success: false,
            error: 'Workflow unavailable (unsupported-target)',
          });
          expect(mockedSavePipeline).not.toHaveBeenCalled();
          return;
        }
        if (organization) {
          expect(result).toEqual({
            success: false,
            error: 'Workflow unavailable (context-mismatch)',
          });
          expect(mockedSavePipeline).not.toHaveBeenCalled();
        } else {
          expect(result).toMatchObject({ success: true });
          expect(mockedSavePipeline).toHaveBeenCalledTimes(1);
        }
        expect(
          workspacePersistence.readWorkspaceConfigDetailed,
        ).toHaveBeenCalledWith('project-a');
        expect(policy).toHaveBeenCalledWith(
          {
            owner: {
              type: organization ? 'organization' : 'user',
              id: organization ? 'org-a' : 'local',
              name: null,
            },
          },
          undefined,
          undefined,
        );
        expect(stored).not.toHaveBeenCalled();
      } finally {
        policy.mockRestore();
        stored.mockRestore();
      }
    },
  );

  it('duplicates a project pipeline into the user store', async () => {
    const pipelinePath = path.join(pipelinesDir, 'deploy.yaml');
    fs.writeFileSync(
      pipelinePath,
      [
        'name: Deploy',
        'description: Ship it',
        'icon: 🚢',
        'on: dispatch',
        'jobs:',
        '  build:',
        '    steps: []',
      ].join('\n'),
      'utf8',
    );

    const result = await getHandler(PIPELINE_CHANNELS.DUPLICATE)(undefined, {
      id: 'project--deploy.yaml',
      cwd: repoPath,
      filePath: pipelinePath,
    });

    expect(mockedSavePipeline).toHaveBeenCalledTimes(1);
    expect(mockedSavePipeline.mock.calls[0]?.[0]).toMatchObject({
      name: 'Deploy (Copy)',
      description: 'Ship it',
      icon: '🚢',
      content: {
        name: 'Deploy',
      },
    });
    expect(result).toMatchObject({
      success: true,
      data: {
        id: 'copy-id',
      },
    });
  });

  it('reloads project pipelines from disk before execute', async () => {
    const pipelinePath = path.join(pipelinesDir, 'deploy.yaml');
    fs.writeFileSync(
      pipelinePath,
      [
        'name: Fresh Pipeline',
        'on: dispatch',
        'jobs:',
        '  build:',
        '    steps: []',
      ].join('\n'),
      'utf8',
    );

    const result = await getHandler(PIPELINE_CHANNELS.EXECUTE)(
      undefined,
      {
        name: 'Stale Pipeline',
        on: 'dispatch',
        jobs: {
          build: {
            steps: [],
          },
        },
      },
      {
        cwd: repoPath,
        repoPath,
        pipelineId: 'project--deploy.yaml',
        pipelineFilePath: pipelinePath,
      },
    );

    expect(mockExecutePipeline).toHaveBeenCalledWith(
      expect.objectContaining({
        name: 'Fresh Pipeline',
      }),
      expect.objectContaining({
        pipelineFileDir: pipelinesDir,
      }),
    );
    expect(result).toMatchObject({
      success: true,
      data: {
        id: 'execution-1',
      },
    });
  });

  it.each([
    { enabled: true, changed: true, initiationSource: 'hook' },
    { enabled: true, changed: false, initiationSource: 'hook' },
    { enabled: false, changed: true, initiationSource: 'hook' },
    { enabled: true, changed: true, initiationSource: 'automation' },
    { enabled: true, changed: false, initiationSource: 'automation' },
    { enabled: false, changed: true, initiationSource: 'automation' },
  ])(
    'checks the authorized $initiationSource snapshot (enabled=$enabled, changed=$changed)',
    async ({ enabled, changed, initiationSource }): Promise<void> => {
      mockBackgroundEnabled.mockReturnValue(enabled);
      const pipelinePath = path.join(pipelinesDir, 'queued.yaml');
      const original = {
        name: 'Queued hook',
        on: 'dispatch',
        jobs: { build: { steps: [{ id: 'run', run: 'echo original' }] } },
      };
      fs.writeFileSync(pipelinePath, yaml.dump(original), 'utf8');
      const authorizedSnapshot =
        await loadProjectPipelineFromDisk(pipelinePath);
      if (changed) {
        fs.writeFileSync(
          pipelinePath,
          yaml.dump({
            ...original,
            jobs: {
              build: {
                steps: [
                  {
                    id: 'child',
                    uses: 'builtin/run-pipeline',
                    with: { pipeline: 'private-child' },
                  },
                ],
              },
            },
          }),
          'utf8',
        );
      }

      // The queue reserves capacity, then dispatches its already-authorized
      // snapshot. The main handler reloads the file at this boundary.
      const executionId = 'queued-hook-snapshot';
      reserveExecution(executionId);
      try {
        const result = await startPipelineExecutionFromMain({
          pipeline: authorizedSnapshot,
          options: {
            cwd: repoPath,
            repoPath,
            pipelineId: 'project--queued.yaml',
            pipelineFilePath: pipelinePath,
            initiationSource:
              initiationSource === 'hook' ? 'hook' : 'automation',
            executionContext: 'personal',
            executionId,
          },
          executionReservationClaimed: true,
          getWindow: () => null,
        });

        if (enabled && changed) {
          expect(result).toEqual({
            success: false,
            error: backgroundExecutionDeniedMessage('unknown-provenance'),
          });
          expect(mockExecutePipeline).not.toHaveBeenCalled();
          expect(tryReserveExecution(executionId)).toBe(true);
        } else {
          expect(result.success).toBe(true);
          expect(mockExecutePipeline).toHaveBeenCalledWith(
            await loadProjectPipelineFromDisk(pipelinePath),
            expect.objectContaining({ pipelineFileDir: pipelinesDir }),
          );
        }
      } finally {
        releaseExecutionReservation(executionId);
      }
    },
  );

  it.each([
    ['other organization', true, 'org-b', 'ok', false, 'context-mismatch'],
    ['Personal', true, undefined, 'ok', false, 'context-mismatch'],
    ['matching organization', true, 'org-a', 'ok', false, undefined],
    ['outside worktree', true, 'org-a', 'ok', false, 'unsupported-target'],
    ['symlinked root', true, 'org-a', 'ok', false, 'unsupported-target'],
    ['symlinked file', true, 'org-a', 'ok', false, 'unsupported-target'],
    ['invalid worktree id', true, 'org-a', 'ok', false, 'unsupported-target'],
    ['repository directory', true, 'org-a', 'ok', false, undefined],
    ['flag off outside worktree', false, 'org-a', 'ok', false, undefined],
    [
      'unreadable workspace',
      true,
      'org-a',
      'unreadable',
      false,
      'unknown-provenance',
    ],
    ['malformed owner', true, 'org-a', 'ok', true, 'unknown-provenance'],
    ['flag off', false, 'org-b', 'unreadable', true, undefined],
  ] as const)(
    'authorizes project-file dispatch: %s',
    async (
      _label,
      enabled,
      organizationId,
      authority,
      ownerMalformed,
      error,
    ): Promise<void> => {
      mockIsFeatureFlagEnabled.mockReturnValue(enabled);
      jest.mocked(readAllSidebarItems).mockResolvedValue({
        version: 1,
        items: [
          {
            type: 'single-repo',
            id: 'project-a',
            name: 'Project',
            repoPath,
            worktrees: [
              { id: 'worktree-a', branchName: 'main', createdAt: '' },
            ],
            color: '',
            collapsed: false,
            order: 0,
          },
        ],
      });
      const read = jest
        .spyOn(workspacePersistence, 'readWorkspaceConfigDetailed')
        .mockResolvedValue({
          authority,
          ownerMalformed,
          memoryMalformed: false,
          config: {
            version: 1,
            type: 'multi-repo',
            repos: [],
            ...(organizationId
              ? { owner: sparseWorkspaceOwnerBinding(organizationId) }
              : {}),
          },
        });
      const snapshot = jest
        .spyOn(pipelineResourceLanes, 'pipelineContextSnapshot')
        .mockResolvedValue('current');
      const fence = jest
        .spyOn(pipelineResourceLanes, 'assertPipelineContextSnapshot')
        .mockResolvedValue(undefined);
      const policy = jest
        .spyOn(pipelineResourceLanes, 'assertPipelineContext')
        .mockImplementation((resource): Promise<void> => {
          const owner = classifyResourceOwner(resource.owner, { strict: true });
          const decision = decideResourceContext({
            resource,
            target: {
              workspaceOwner:
                typeof owner === 'object'
                  ? {
                      kind: 'organization',
                      organizationId: owner.organizationId,
                    }
                  : { kind: 'personal' },
            },
            invocation: {
              mode: 'foreground',
              context: { kind: 'organization', organizationId: 'org-a' },
            },
          });
          if (!decision.allow)
            return Promise.reject(
              new Error(`Workflow unavailable (${decision.reason})`),
            );
          return Promise.resolve();
        });
      mockResolveWorktreeCwd.mockReturnValue(
        _label.includes('outside worktree')
          ? path.join(repoPath, 'other')
          : _label === 'repository directory'
            ? tempDir
            : repoPath,
      );
      if (_label === 'symlinked root') {
        const outside = path.join(tempDir, 'outside-pipelines');
        fs.renameSync(pipelinesDir, outside);
        fs.symlinkSync(outside, pipelinesDir);
      }
      const pipelinePath = path.join(pipelinesDir, 'deploy.yaml');
      fs.writeFileSync(pipelinePath, 'name: Fresh\non: dispatch\njobs: {}\n');
      if (_label === 'symlinked file') {
        const outside = path.join(tempDir, 'outside.yaml');
        fs.renameSync(pipelinePath, outside);
        fs.symlinkSync(outside, pipelinePath);
      }

      try {
        const result = await startPipelineExecutionFromMain({
          pipeline: { name: 'Stale', on: 'dispatch', jobs: {} },
          options: {
            cwd: repoPath,
            repoPath,
            projectId: 'project-a',
            worktreeId:
              _label === 'invalid worktree id' ? '../other' : 'worktree-a',
            pipelineId: 'project--deploy.yaml',
            pipelineFilePath: pipelinePath,
          },
          getWindow: () => null,
        });
        if (error) {
          expect(result).toEqual({
            success: false,
            error: `Workflow unavailable (${error})`,
          });
          expect(mockExecutePipeline).not.toHaveBeenCalled();
        } else {
          expect(result).toMatchObject({ success: true });
          expect(mockExecutePipeline).toHaveBeenCalledWith(
            expect.objectContaining({ name: 'Fresh' }),
            expect.anything(),
          );
          if (enabled)
            expect(policy).toHaveBeenCalledWith(
              { owner: { type: 'organization', id: 'org-a', name: null } },
              'project-a',
            );
        }
        if (!enabled) {
          expect(read).not.toHaveBeenCalled();
          expect(policy).not.toHaveBeenCalled();
          expect(mockResolveWorktreeCwd).not.toHaveBeenCalled();
        }
      } finally {
        read.mockRestore();
        snapshot.mockRestore();
        fence.mockRestore();
        policy.mockRestore();
      }
    },
  );

  it.each([
    ['project folder', undefined],
    ['cwd outside the project folder', 'unsupported-target'],
    ['symlinked cwd', 'unsupported-target'],
    ['no worktree and no directory scope', 'unsupported-target'],
    ['target outside the project folder', 'unsupported-target'],
  ] as const)(
    'authorizes a project-file dispatch with no worktree: %s',
    async (label, error): Promise<void> => {
      mockIsFeatureFlagEnabled.mockReturnValue(true);
      jest.mocked(readAllSidebarItems).mockResolvedValue({
        version: 1,
        items: [
          {
            type: 'single-repo',
            id: 'project-a',
            name: 'Project',
            repoPath,
            worktrees: [],
            color: '',
            collapsed: false,
            order: 0,
          },
        ],
      });
      const read = jest
        .spyOn(workspacePersistence, 'readWorkspaceConfigDetailed')
        .mockResolvedValue({
          authority: 'ok',
          ownerMalformed: false,
          memoryMalformed: false,
          config: {
            version: 1,
            type: 'multi-repo',
            repos: [],
            owner: {
              type: 'organization',
              organizationId: 'org-a',
              projectId: 'project-a',
              instanceId: 'instance-a',
              bindingGeneration: 1,
            },
          },
        });
      const snapshot = jest
        .spyOn(pipelineResourceLanes, 'pipelineContextSnapshot')
        .mockResolvedValue('current');
      const fence = jest
        .spyOn(pipelineResourceLanes, 'assertPipelineContextSnapshot')
        .mockResolvedValue(undefined);
      const policy = jest
        .spyOn(pipelineResourceLanes, 'assertPipelineContext')
        .mockResolvedValue(undefined);
      const pipelinePath = path.join(pipelinesDir, 'deploy.yaml');
      fs.writeFileSync(pipelinePath, 'name: Fresh\non: dispatch\njobs: {}\n');
      let cwd = repoPath;
      if (label === 'cwd outside the project folder') cwd = tempDir;
      if (label === 'symlinked cwd') {
        const outside = path.join(tempDir, 'outside');
        fs.mkdirSync(outside);
        cwd = path.join(repoPath, 'linked');
        fs.symlinkSync(outside, cwd);
      }

      try {
        const result = await startPipelineExecutionFromMain({
          pipeline: { name: 'Stale', on: 'dispatch', jobs: {} },
          options: {
            cwd,
            repoPath,
            projectId: 'project-a',
            ...(label === 'no worktree and no directory scope'
              ? {}
              : {
                  scope: 'directory' as const,
                  target: {
                    scope: 'directory' as const,
                    path:
                      label === 'target outside the project folder'
                        ? tempDir
                        : cwd,
                  },
                }),
            pipelineId: 'project--deploy.yaml',
            pipelineFilePath: pipelinePath,
          },
          getWindow: () => null,
        });
        if (error) {
          expect(result).toEqual({
            success: false,
            error: `Workflow unavailable (${error})`,
          });
          expect(mockExecutePipeline).not.toHaveBeenCalled();
        } else {
          expect(result).toMatchObject({ success: true });
          expect(mockExecutePipeline).toHaveBeenCalledWith(
            expect.objectContaining({ name: 'Fresh' }),
            expect.anything(),
          );
        }
        expect(mockResolveWorktreeCwd).not.toHaveBeenCalled();
      } finally {
        read.mockRestore();
        snapshot.mockRestore();
        fence.mockRestore();
        policy.mockRestore();
      }
    },
  );

  it.each([
    ...['stored', 'shared'].flatMap((source) =>
      [
        'foreign worktree',
        'foreign cwd',
        'foreign target',
        'foreign target path',
        'symlink',
        'matching',
        'flag off',
      ].map((scenario) => ({ source, scenario })),
    ),
  ])(
    'binds $source dispatch to canonical workspace and worktree data: $scenario',
    async ({ source, scenario }): Promise<void> => {
      mockIsFeatureFlagEnabled.mockReturnValue(scenario !== 'flag off');
      const personalPath = path.join(tempDir, 'personal');
      fs.mkdirSync(personalPath);
      const linkedPath = path.join(repoPath, 'linked');
      fs.symlinkSync(personalPath, linkedPath);
      jest.mocked(readAllSidebarItems).mockResolvedValue({
        version: 1,
        items: [
          {
            type: 'single-repo',
            id: 'project-a',
            name: 'Org A',
            repoPath,
            owner: {
              type: 'organization',
              organizationId: 'org-a',
              projectId: 'project-a',
              instanceId: 'instance-a',
              bindingGeneration: 1,
            },
            worktrees: [{ id: 'wt-a', branchName: 'a', createdAt: '' }],
            color: '',
            collapsed: false,
            order: 0,
          },
          {
            type: 'single-repo',
            id: 'personal',
            name: 'Personal',
            repoPath: personalPath,
            worktrees: [
              { id: 'wt-personal', branchName: 'personal', createdAt: '' },
            ],
            color: '',
            collapsed: false,
            order: 1,
          },
        ],
      });
      mockResolveWorktreeCwd.mockImplementation((projectId: string): string =>
        projectId === 'project-a' ? repoPath : personalPath,
      );
      const sparseSharedOwner: NonNullable<SharedPipelineDetail['owner']> = {
        type: 'organization',
        id: 'org-a',
        name: 'Org A',
      };
      // Preserve the legacy null organization name returned by this fixture.
      Reflect.set(sparseSharedOwner, 'name', null);
      mockedGetSharedPipeline.mockResolvedValue(
        createSharedPipelineDetail({
          id: 'remote-exec',
          owner: sparseSharedOwner,
        }),
      );
      const snapshot = jest
        .spyOn(pipelineResourceLanes, 'pipelineContextSnapshot')
        .mockResolvedValue('current');
      const fence = jest
        .spyOn(pipelineResourceLanes, 'assertPipelineContextSnapshot')
        .mockResolvedValue();
      const shared = jest
        .spyOn(pipelineResourceLanes, 'assertPipelineContext')
        .mockResolvedValue();
      const stored = jest
        .spyOn(pipelineInstallContext, 'assertStoredPipelineContext')
        .mockResolvedValue();
      try {
        const result = await startPipelineExecutionFromMain({
          pipeline: { name: 'Org pipeline', on: 'dispatch', jobs: {} },
          options: {
            cwd:
              scenario === 'foreign cwd' ||
              scenario === 'foreign worktree' ||
              scenario === 'flag off'
                ? personalPath
                : scenario === 'symlink'
                  ? linkedPath
                  : repoPath,
            projectId: 'project-a',
            worktreeId:
              scenario === 'foreign worktree' ? 'wt-personal' : 'wt-a',
            ...(scenario === 'foreign target'
              ? {
                  target: {
                    scope: 'worktree',
                    workspace_id: 'personal',
                    worktree_id: 'wt-personal',
                    path: repoPath,
                    created: false,
                  } satisfies NonNullable<ExecutionOptions['target']>,
                }
              : {}),
            ...(scenario === 'foreign target path'
              ? {
                  target: {
                    scope: 'directory',
                    path: personalPath,
                  } satisfies NonNullable<ExecutionOptions['target']>,
                }
              : {}),
            pipelineId:
              source === 'shared'
                ? 'shared:canopy-cloud:remote-exec'
                : 'installed-org-a',
            ...(source === 'shared'
              ? {
                  sharedPipeline: {
                    serverId: 'canopy-cloud',
                    remoteId: 'remote-exec',
                  },
                }
              : {}),
          },
          getWindow: () => null,
        });
        if (scenario === 'matching' || scenario === 'flag off') {
          expect(result).toMatchObject({ success: true });
          expect(mockExecutePipeline).toHaveBeenCalled();
          if (scenario === 'matching') {
            if (source === 'shared')
              expect(shared).toHaveBeenCalledWith(
                { owner: { type: 'organization', id: 'org-a', name: null } },
                'project-a',
                undefined,
              );
            else
              expect(stored).toHaveBeenCalledWith(
                'installed-org-a',
                'project-a',
              );
          } else {
            expect(readAllSidebarItems).not.toHaveBeenCalled();
            expect(mockResolveWorktreeCwd).not.toHaveBeenCalled();
          }
        } else {
          expect(result).toEqual({
            success: false,
            error: 'Workflow unavailable (unsupported-target)',
          });
          expect(mockExecutePipeline).not.toHaveBeenCalled();
          expect(shared).not.toHaveBeenCalled();
          expect(stored).not.toHaveBeenCalled();
        }
      } finally {
        snapshot.mockRestore();
        fence.mockRestore();
        shared.mockRestore();
        stored.mockRestore();
      }
    },
  );

  it('denies dispatch of an installed organization pipeline before starting execution', async () => {
    mockIsFeatureFlagEnabled.mockReturnValue(true);
    const snapshot = jest
      .spyOn(pipelineResourceLanes, 'pipelineContextSnapshot')
      .mockResolvedValue('current');
    const check = jest
      .spyOn(pipelineInstallContext, 'assertStoredPipelineContext')
      .mockRejectedValue(new Error('Workflow unavailable (context-mismatch)'));
    try {
      const result = await startPipelineExecutionFromMain({
        pipeline: { name: 'Installed', on: 'dispatch', jobs: {} },
        options: { cwd: repoPath, pipelineId: 'installed-org-a' },
        getWindow: () => null,
      });
      expect(result).toEqual({
        success: false,
        error: 'Workflow unavailable (context-mismatch)',
      });
      expect(mockExecutePipeline).not.toHaveBeenCalled();
    } finally {
      check.mockRestore();
      snapshot.mockRestore();
    }
  });

  it('releases an explicit execution id reservation when startup fails', async () => {
    const executionId = 'explicit-start-failure';
    mockExecutePipeline.mockRejectedValueOnce(new Error('startup failed'));

    await expect(
      startPipelineExecutionFromMain({
        pipeline: {
          name: 'Failing explicit start',
          on: 'dispatch',
          jobs: {},
        },
        options: {
          cwd: repoPath,
          pipelineId: 'failing-explicit-start',
          executionId,
        },
        getWindow: () => null,
      }),
    ).resolves.toEqual({
      success: false,
      error: 'startup failed',
    });

    expect(
      tryReserveExecution(executionId, 'matrix-variant-cancellation'),
    ).toBe(true);
    releaseExecutionReservation(executionId, 'matrix-variant-cancellation');
  });

  it('does not derive a preference locator for inline execute requests', async () => {
    await getHandler(PIPELINE_CHANNELS.EXECUTE)(
      undefined,
      {
        name: 'Inline Pipeline',
        on: 'dispatch',
        jobs: {
          build: {
            steps: [],
          },
        },
      },
      {
        cwd: repoPath,
        repoPath,
        pipelineId: 'inline-pipeline',
      },
    );

    const executeCall = mockExecutePipeline.mock.calls[0];
    const executeOptions = executeCall?.[1];

    expect(executeOptions).toMatchObject({
      pipelinePreferenceLocator: undefined,
    });
  });

  it('forces directory scope for App Advisor work-entry execute requests', async () => {
    // Without this forcing, projectId+worktreeId infer `worktree` scope and
    // App Advisor entry ids fail git worktree target resolution with
    // "Worktree target ... no longer exists".
    await getHandler(PIPELINE_CHANNELS.EXECUTE)(
      undefined,
      {
        name: 'Advisor Pipeline',
        on: 'dispatch',
        jobs: {
          build: {
            steps: [],
          },
        },
      },
      {
        cwd: repoPath,
        pipelineId: 'inline-pipeline',
        projectId: 'app-advisor',
        worktreeId: 'entry-1',
      },
    );

    const executeOptions = mockExecutePipeline.mock.calls[0]?.[1];
    expect(executeOptions).toMatchObject({
      scope: 'directory',
      target: { scope: 'directory', path: repoPath },
      projectId: 'app-advisor',
      worktreeId: 'entry-1',
    });
  });

  it('loads a shared pipeline on GET', async () => {
    mockedGetSharedPipeline.mockResolvedValue(
      createSharedPipelineDetail({
        id: 'remote-shared',
        name: 'Shared Deploy',
        shareScope: 'team',
        owner: {
          type: 'team',
          id: 'team-1',
          name: 'Platform',
          organization: {
            id: 'org-1',
            name: 'Acme',
            createdAt: '2026-04-26T12:00:00.000Z',
            updatedAt: '2026-04-26T12:00:00.000Z',
          },
        },
      }),
    );

    const result = await getHandler(PIPELINE_CHANNELS.GET)(undefined, {
      source: 'shared',
      remoteId: 'remote-shared',
    });

    expect(mockedGetSharedPipeline).toHaveBeenCalledWith('remote-shared');
    expect(result).toMatchObject({
      success: true,
      data: {
        info: {
          id: 'shared:canopy-cloud:remote-shared',
          source: 'shared',
          serverId: 'canopy-cloud',
          remoteId: 'remote-shared',
          serverName: 'Canopy Cloud',
          shareScope: 'team',
          owner: {
            type: 'team',
            id: 'team-1',
            name: 'Platform',
          },
        },
        content: {
          name: 'Shared Deploy',
        },
      },
    });
  });

  it.each([PIPELINE_CHANNELS.GET, PIPELINE_CHANNELS.DUPLICATE])(
    'refuses installed origins at %s',
    async (channel) => {
      mockIsFeatureFlagEnabled.mockReturnValue(true);
      const check = jest
        .spyOn(pipelineInstallContext, 'assertStoredPipelineContext')
        .mockRejectedValue(
          new Error('Workflow unavailable (context-mismatch)'),
        );
      try {
        const result = await getHandler(channel)(undefined, 'installed-org-a');
        expect(result).toMatchObject({
          success: false,
          error: 'Workflow unavailable (context-mismatch)',
        });
        expect(check).toHaveBeenCalledWith('installed-org-a');
        expect(mockedSavePipeline).not.toHaveBeenCalled();
      } finally {
        check.mockRestore();
      }
    },
  );

  it('refuses editing an installed origin outside its context', async () => {
    mockIsFeatureFlagEnabled.mockReturnValue(true);
    const check = jest
      .spyOn(pipelineInstallContext, 'assertStoredPipelineContext')
      .mockRejectedValue(new Error('Workflow unavailable (context-mismatch)'));
    try {
      const result = await getHandler(PIPELINE_CHANNELS.SAVE)(undefined, {
        id: 'installed-org-a',
      });
      expect(result).toMatchObject({ success: false });
      expect(mockedSavePipeline).not.toHaveBeenCalled();
    } finally {
      check.mockRestore();
    }
  });

  it('keeps the SAVE receipt when definition rollback fails', async (): Promise<void> => {
    mockIsFeatureFlagEnabled.mockReturnValue(true);
    const undo = jest.fn<Promise<void>, []>(() => Promise.resolve());
    const record = jest
      .spyOn(pipelineInstallContext, 'recordSharedPipelineInstall')
      .mockImplementation((_detail, _id, onRollback): Promise<void> => {
        onRollback?.(undo);
        return Promise.reject(new Error('receipt write failed'));
      });
    mockedSavePipeline.mockImplementation((input) => ({
      success: true,
      data: {
        id: input.id ?? '',
        name: 'Copy',
        filename: `${input.id ?? ''}.yaml`,
        description: '',
        icon: '',
        source: 'user',
        readonly: false,
        createdAt: '',
        updatedAt: '',
      },
    }));
    jest
      .mocked(pipelineService.deletePipeline)
      .mockReturnValue({ success: false, error: 'definition rollback failed' });
    mockedGetSharedPipeline.mockResolvedValue(
      createSharedPipelineDetail({ id: 'remote-copy' }),
    );
    try {
      const result = await getHandler(PIPELINE_CHANNELS.SAVE)(undefined, {
        name: 'Copy',
        sourceRemoteId: 'remote-copy',
      });
      expect(result).toMatchObject({
        success: false,
        error: 'receipt write failed; definition rollback failed',
      });
      expect(undo).not.toHaveBeenCalled();
    } finally {
      record.mockRestore();
    }
  });

  it.each(['none', 'create', 'receipt'])(
    'binds scoped SAVE to its persisted id and rolls back failures (%s)',
    async (fail) => {
      mockIsFeatureFlagEnabled.mockReturnValue(true);
      const directory = path.join(tempDir, 'stored');
      const dir = jest
        .spyOn(pipelinePaths, 'getUserPipelinesDir')
        .mockReturnValue(directory);
      const index = jest
        .spyOn(pipelinePaths, 'getUserPipelineIndexPath')
        .mockReturnValue(path.join(directory, 'index.json'));
      const undo = jest.fn<Promise<void>, []>(() => Promise.resolve());
      let receiptId: string | undefined;
      const record = jest
        .spyOn(pipelineInstallContext, 'recordSharedPipelineInstall')
        .mockImplementation((_detail, id, onRollback) => {
          receiptId = id;
          onRollback?.(undo);
          if (fail === 'receipt')
            return Promise.reject(new Error('receipt write failed'));
          return Promise.resolve();
        });
      mockedSavePipeline.mockImplementation(saveStoredPipeline);
      if (fail === 'create')
        mockedSavePipeline.mockReturnValueOnce({
          success: false,
          error: 'create failed',
        });
      jest
        .mocked(pipelineService.deletePipeline)
        .mockImplementation(deleteStoredPipeline);
      mockedGetSharedPipeline.mockResolvedValue(
        createSharedPipelineDetail({ id: 'remote-copy' }),
      );
      try {
        const result = await getHandler(PIPELINE_CHANNELS.SAVE)(undefined, {
          name: 'Org copy',
          description: '',
          icon: '',
          sourceRemoteId: 'remote-copy',
        });
        if (fail !== 'none') {
          expect(result).toMatchObject({ success: false });
          if (fail === 'create') expect(record).not.toHaveBeenCalled();
          else expect(undo).toHaveBeenCalledTimes(1);
          expect(
            listStoredPipelines().data?.filter((row) => row.source === 'user'),
          ).toEqual([]);
        } else {
          expect(result).toMatchObject({
            success: true,
            data: { id: receiptId },
          });
          expect(listStoredPipelines().data).toContainEqual(
            expect.objectContaining({ id: receiptId }),
          );
        }
      } finally {
        record.mockRestore();
        dir.mockRestore();
        index.mockRestore();
      }
    },
  );

  it.each([
    { variant: 'shared', fail: 'none' },
    { variant: 'stored', fail: 'none' },
    { variant: 'shared', fail: 'create' },
    { variant: 'stored', fail: 'create' },
    { variant: 'shared', fail: 'receipt' },
    { variant: 'stored', fail: 'receipt' },
    { variant: 'shared', fail: 'identity' },
    { variant: 'stored', fail: 'identity' },
  ])(
    'binds scoped DUPLICATE to its receipt and rolls back ($variant / $fail)',
    async ({ variant, fail }) => {
      mockIsFeatureFlagEnabled.mockReturnValue(true);
      const directory = path.join(tempDir, 'stored');
      const dir = jest
        .spyOn(pipelinePaths, 'getUserPipelinesDir')
        .mockReturnValue(directory);
      const index = jest
        .spyOn(pipelinePaths, 'getUserPipelineIndexPath')
        .mockReturnValue(path.join(directory, 'index.json'));
      const undo = jest.fn<Promise<void>, []>(() => Promise.resolve());
      let receiptId: string | undefined;
      const record = jest
        .spyOn(pipelineInstallContext, 'recordSharedPipelineInstall')
        .mockImplementation((_detail, id, onRollback) => {
          receiptId = id;
          onRollback?.(undo);
          if (fail === 'receipt')
            return Promise.reject(new Error('receipt write failed'));
          return Promise.resolve();
        });
      mockedSavePipeline.mockImplementation(saveStoredPipeline);
      if (fail === 'create')
        mockedSavePipeline.mockReturnValueOnce({
          success: false,
          error: 'create failed',
        });
      jest
        .mocked(pipelineService.deletePipeline)
        .mockImplementation(deleteStoredPipeline);
      mockedGetSharedPipeline.mockResolvedValue(
        createSharedPipelineDetail({ id: 'remote-copy' }),
      );
      const copy = jest
        .spyOn(pipelineInstallContext, 'copyPipelineInstallOrigin')
        .mockImplementation((_source, id, onRollback) => {
          receiptId = id;
          onRollback?.(undo);
          return fail === 'receipt'
            ? Promise.reject(new Error('receipt write failed'))
            : Promise.resolve();
        });
      if (fail === 'identity')
        mockedSavePipeline.mockImplementationOnce((input) =>
          saveStoredPipeline(input),
        );
      const check = jest
        .spyOn(pipelineInstallContext, 'assertStoredPipelineContext')
        .mockResolvedValue();
      jest.mocked(pipelineService.getPipeline).mockReturnValue({
        success: true,
        data: {
          info: {
            id: 'original',
            name: 'Original',
            filename: 'original.yaml',
            description: '',
            icon: '',
            source: 'user',
            readonly: false,
            createdAt: '',
            updatedAt: '',
          },
          content: { name: 'Original', on: 'dispatch', jobs: {} },
        },
      });
      try {
        const result = await getHandler(PIPELINE_CHANNELS.DUPLICATE)(
          undefined,
          variant === 'stored'
            ? 'original'
            : { source: 'shared', remoteId: 'remote-copy' },
        );
        if (fail !== 'none') {
          expect(result).toMatchObject({ success: false });
          expect(undo).toHaveBeenCalledTimes(1);
          expect(
            listStoredPipelines().data?.filter((row) => row.source === 'user'),
          ).toEqual([]);
        } else {
          expect(result).toMatchObject({
            success: true,
            data: { id: receiptId },
          });
          expect(listStoredPipelines().data).toContainEqual(
            expect.objectContaining({ id: receiptId }),
          );
        }
      } finally {
        copy.mockRestore();
        check.mockRestore();
        record.mockRestore();
        dir.mockRestore();
        index.mockRestore();
      }
    },
  );

  describe('install subscriptions', () => {
    const mockedRecordInstall = jest.mocked(recordSharedItemInstall);
    const mockedRecordUninstall = jest.mocked(recordSharedItemLocalUninstall);

    async function flushTurns(): Promise<void> {
      for (let turn = 0; turn < 20; turn += 1) await Promise.resolve();
    }

    beforeEach(() => {
      mockedRecordInstall.mockReset();
      mockedRecordUninstall.mockReset();
    });

    it.each(['none', 'receipt'])(
      'registers a scoped SAVE install only after it persists (failure=%s)',
      async (fail) => {
        mockIsFeatureFlagEnabled.mockReturnValue(true);
        const directory = path.join(tempDir, 'stored');
        const dir = jest
          .spyOn(pipelinePaths, 'getUserPipelinesDir')
          .mockReturnValue(directory);
        const index = jest
          .spyOn(pipelinePaths, 'getUserPipelineIndexPath')
          .mockReturnValue(path.join(directory, 'index.json'));
        const record = jest
          .spyOn(pipelineInstallContext, 'recordSharedPipelineInstall')
          .mockImplementation(() =>
            fail === 'receipt'
              ? Promise.reject(new Error('receipt write failed'))
              : Promise.resolve(),
          );
        mockedSavePipeline.mockImplementation(saveStoredPipeline);
        jest
          .mocked(pipelineService.deletePipeline)
          .mockImplementation(deleteStoredPipeline);
        mockedGetSharedPipeline.mockResolvedValue(
          createSharedPipelineDetail({
            id: 'remote-copy',
            contentHash: 'remote-hash',
          }),
        );
        try {
          const result = await getHandler(PIPELINE_CHANNELS.SAVE)(undefined, {
            name: 'Org copy',
            description: '',
            icon: '',
            sourceRemoteId: 'remote-copy',
          });
          if (fail === 'none') {
            const savedId = listStoredPipelines().data?.find(
              (row) => row.source === 'user',
            )?.id;
            expect(result).toMatchObject({ success: true });
            expect(mockedRecordInstall).toHaveBeenCalledWith({
              kind: 'pipeline',
              remoteId: 'remote-copy',
              sourceKind: 'shared',
              contentHash: 'remote-hash',
              localId: savedId,
            });
          } else {
            expect(result).toMatchObject({ success: false });
            expect(mockedRecordInstall).not.toHaveBeenCalled();
          }
        } finally {
          record.mockRestore();
          dir.mockRestore();
          index.mockRestore();
        }
      },
    );

    it('registers a SAVE install from a shared source without a hash while organization projects are off', async () => {
      mockedSavePipeline.mockReturnValue({
        success: true,
        data: {
          id: 'installed-id',
          name: 'Shared Deploy',
          description: '',
          icon: '',
          filename: 'installed-id.yaml',
          createdAt: '2026-10-01T00:00:00.000Z',
          updatedAt: '2026-10-01T00:00:00.000Z',
          source: 'user',
          readonly: false,
        },
      });
      const result = await getHandler(PIPELINE_CHANNELS.SAVE)(undefined, {
        name: 'Shared Deploy',
        description: '',
        icon: '',
        content: { name: 'Shared Deploy', on: 'dispatch', jobs: {} },
        sourceRemoteId: 'remote-copy',
      });
      expect(result).toMatchObject({ success: true });
      expect(mockedRecordInstall).toHaveBeenCalledWith({
        kind: 'pipeline',
        remoteId: 'remote-copy',
        sourceKind: 'shared',
        contentHash: null,
        localId: 'installed-id',
      });
    });

    it('does not register a failed SAVE install while organization projects are off', async () => {
      mockedSavePipeline.mockReturnValue({
        success: false,
        error: 'disk full',
      });
      await getHandler(PIPELINE_CHANNELS.SAVE)(undefined, {
        name: 'Shared Deploy',
        description: '',
        icon: '',
        content: { name: 'Shared Deploy', on: 'dispatch', jobs: {} },
        sourceRemoteId: 'remote-copy',
      });
      expect(mockedRecordInstall).not.toHaveBeenCalled();
    });

    it('neither registers nor unregisters a local edit of an installed pipeline', async () => {
      const pipelinePackageService =
        await import('../pipelines/pipeline-package-service');
      const remove = jest
        .spyOn(pipelinePackageService, 'removePackageInstall')
        .mockResolvedValue(undefined);
      mockedSavePipeline.mockReturnValue({
        success: true,
        data: {
          id: 'installed-id',
          name: 'Edited',
          description: '',
          icon: '',
          filename: 'installed-id.yaml',
          createdAt: '2026-10-01T00:00:00.000Z',
          updatedAt: '2026-10-01T00:00:00.000Z',
          source: 'user',
          readonly: false,
        },
      });
      try {
        const result = await getHandler(PIPELINE_CHANNELS.SAVE)(undefined, {
          id: 'installed-id',
          name: 'Edited',
          description: '',
          icon: '',
          content: { name: 'Edited', on: 'dispatch', jobs: {} },
        });
        await flushTurns();
        expect(result).toMatchObject({ success: true });
        expect(remove).toHaveBeenCalledWith('installed-id');
        expect(mockedRecordInstall).not.toHaveBeenCalled();
        expect(mockedRecordUninstall).not.toHaveBeenCalled();
      } finally {
        remove.mockRestore();
      }
    });

    it('unregisters a deleted pipeline by its local id, even after an edit dropped its package record', async () => {
      const pipelinePackageService =
        await import('../pipelines/pipeline-package-service');
      const list = jest
        .spyOn(pipelinePackageService, 'listPackageInstalls')
        .mockResolvedValue([]);
      const remove = jest
        .spyOn(pipelinePackageService, 'removePackageInstall')
        .mockResolvedValue(undefined);
      jest
        .mocked(pipelineService.deletePipeline)
        .mockReturnValue({ success: true, data: undefined });
      try {
        const result = await getHandler(PIPELINE_CHANNELS.DELETE)(
          undefined,
          'installed-id',
        );
        await flushTurns();
        expect(result).toMatchObject({ success: true });
        expect(mockedRecordUninstall).toHaveBeenCalledWith({
          kind: 'pipeline',
          localId: 'installed-id',
        });
        expect(remove).toHaveBeenCalledWith('installed-id');
      } finally {
        list.mockRestore();
        remove.mockRestore();
      }
    });

    it('does not unregister a failed delete', async () => {
      const pipelinePackageService =
        await import('../pipelines/pipeline-package-service');
      const remove = jest
        .spyOn(pipelinePackageService, 'removePackageInstall')
        .mockResolvedValue(undefined);
      try {
        jest
          .mocked(pipelineService.deletePipeline)
          .mockReturnValueOnce({ success: false, error: 'missing' });
        await getHandler(PIPELINE_CHANNELS.DELETE)(undefined, 'missing-id');
        await flushTurns();
        expect(mockedRecordUninstall).not.toHaveBeenCalled();
      } finally {
        remove.mockRestore();
      }
    });
  });

  it('rejects malformed scoped sourceRemoteId before fetching', async () => {
    mockIsFeatureFlagEnabled.mockReturnValue(true);
    const result = await getHandler(PIPELINE_CHANNELS.SAVE)(undefined, {
      sourceRemoteId: '../remote',
    });
    expect(result).toMatchObject({ success: false });
    expect(result).toHaveProperty(
      'error',
      expect.stringContaining('Invalid sourceRemoteId'),
    );
    expect(mockedGetSharedPipeline).not.toHaveBeenCalled();
  });

  it('rejects malformed scoped sourcePipelineId before sharing', async () => {
    mockIsFeatureFlagEnabled.mockReturnValue(true);
    const result = await getHandler(PIPELINE_CHANNELS.SHARED_CREATE)(
      undefined,
      { sourcePipelineId: '../local', rawPipeline: 'name: Release' },
    );
    expect(result).toMatchObject({ success: false });
    expect(result).toHaveProperty(
      'error',
      expect.stringContaining('Invalid sourcePipelineId'),
    );
    expect(mockedCreateSharedPipeline).not.toHaveBeenCalled();
  });

  it('records a shared install receipt before saving the local copy', async () => {
    mockIsFeatureFlagEnabled.mockReturnValue(true);
    const record = jest
      .spyOn(pipelineInstallContext, 'recordSharedPipelineInstall')
      .mockResolvedValue();
    const detail = createSharedPipelineDetail({
      id: 'remote-copy',
      name: 'Shared Copy',
    });
    mockedGetSharedPipeline.mockResolvedValue(detail);
    try {
      await getHandler(PIPELINE_CHANNELS.DUPLICATE)(undefined, {
        source: 'shared',
        remoteId: 'remote-copy',
      });
      expect(record).toHaveBeenCalledWith(
        detail,
        expect.any(String),
        expect.any(Function),
      );
      expect(record.mock.invocationCallOrder[0]).toBeLessThan(
        mockedSavePipeline.mock.invocationCallOrder[0],
      );
    } finally {
      record.mockRestore();
    }
  });

  it('duplicates a shared pipeline into the user store', async () => {
    mockedGetSharedPipeline.mockResolvedValue(
      createSharedPipelineDetail({
        id: 'remote-copy',
        name: 'Shared Copy Source',
        description: 'Remote description',
        icon: '🛰️',
      }),
    );

    const result = await getHandler(PIPELINE_CHANNELS.DUPLICATE)(undefined, {
      source: 'shared',
      remoteId: 'remote-copy',
    });

    expect(mockedGetSharedPipeline).toHaveBeenCalledWith('remote-copy');
    const saveInput: PipelineSaveInput | undefined =
      mockedSavePipeline.mock.calls[0]?.[0];
    expect(saveInput).toMatchObject({
      name: 'Shared Copy Source (Copy)',
      description: 'Remote description',
      icon: '🛰️',
    });
    expect(saveInput?.content.name).toBe('Shared Copy Source');
    expect(result).toMatchObject({
      success: true,
      data: {
        source: 'user',
      },
    });
  });

  it('logs a failed package analysis and returns its reason to the renderer', async () => {
    const pipelinePackageService =
      await import('../pipelines/pipeline-package-service');
    const failure = new Error(
      'modelId must be a non-empty model identifier without whitespace',
    );
    const analyze = jest
      .spyOn(pipelinePackageService, 'analyzePackageRequest')
      .mockRejectedValue(failure);
    const logError = jest
      .spyOn(mainProcessLogging, 'logMainProcessError')
      .mockImplementation(() => undefined);

    try {
      await expect(
        getHandler(PIPELINE_CHANNELS.ANALYZE_PACKAGE)(undefined, {
          rawPipeline: 'name: Example\n',
          pipelineId: 'local-pipeline',
        }),
      ).resolves.toEqual({
        success: false,
        error:
          'modelId must be a non-empty model identifier without whitespace',
      });
      expect(logError).toHaveBeenCalledWith(
        '[pipelines] Package analysis failed for local-pipeline',
        failure,
      );
    } finally {
      analyze.mockRestore();
      logError.mockRestore();
    }
  });

  it('saves shared pipeline edits through the package-preserving update', async () => {
    // A plain YAML PUT makes the server detach a package share's dependencies,
    // leaving a share the Run dialog refuses. Every in-place save must go
    // through the path that re-packages the edit.
    const detail = createSharedPipelineDetail({ id: 'remote-3' });
    const pipelinePackageService =
      await import('../pipelines/pipeline-package-service');
    const preserving = jest
      .spyOn(pipelinePackageService, 'updateSharedPipelinePreservingPackage')
      .mockResolvedValue(detail);

    await expect(
      getHandler(PIPELINE_CHANNELS.SHARED_UPDATE)(undefined, {
        remoteId: 'remote-3',
        rawPipeline: detail.rawPipeline,
      }),
    ).resolves.toEqual({
      success: true,
      data: { ...detail, scopes: ['directory'] },
    });
    expect(preserving).toHaveBeenCalledWith(
      'remote-3',
      detail.rawPipeline,
      undefined,
      {
        expectedContentHash: undefined,
        shareScope: undefined,
        teamId: undefined,
        organizationId: undefined,
        distributionMode: undefined,
        committedPackageUploadId: undefined,
      },
    );
    expect(mockedUpdateSharedPipeline).not.toHaveBeenCalled();
    preserving.mockRestore();
  });

  it('reports installed and publisher-shared automations affected by an edit', async () => {
    const activity = (
      id: string,
      name: string,
      extra: Partial<ScheduledActivity>,
    ): ScheduledActivity => ({
      version: 1,
      id,
      name,
      enabled: true,
      schedule: { kind: 'cron', expression: '0 * * * *', timezone: 'local' },
      action: { type: 'app_advisor_prompt', prompt: 'Review' },
      createdAt: '2026-09-26T12:00:00.000Z',
      updatedAt: '2026-09-26T12:00:00.000Z',
      failureCount: 0,
      ...extra,
    });
    const remote = (remoteId: string): ScheduledActivity['remote'] => ({
      remoteId,
      contentHash: 'c'.repeat(64),
      shareScope: 'private',
      sharedAt: '2026-09-26T12:00:00.000Z',
    });
    mockListAutomationsForImpact.mockResolvedValue(
      [
        activity('installed', 'Installed automation', {
          action: {
            type: 'worktree_pipeline',
            workspaceId: 'workspace-1',
            pipelineId: 'shared:canopy-cloud:pipeline-1',
            pipelineSource: 'shared',
            sharedPipeline: {
              serverId: 'canopy-cloud',
              remoteId: 'pipeline-1',
              installPin: {
                pipelineContentHash: 'a'.repeat(64),
                distributionMode: 'definition_only',
              },
            },
          },
        }),
        activity('shared-hit', 'Shared automation', {
          remote: remote('automation-hit'),
        }),
        activity('shared-inline', 'Inline automation', {
          remote: remote('automation-inline'),
        }),
        activity('shared-unavailable', 'Unavailable automation', {
          remote: remote('automation-unavailable'),
        }),
      ].map((entry) => ({
        activity: entry,
        visibleInCurrentContext: entry.id !== 'shared-unavailable',
      })),
    );
    mockGetSharedAutomationForImpact.mockImplementation((remoteId: string) => {
      if (remoteId === 'automation-unavailable') {
        return Promise.reject(new Error('offline'));
      }
      return Promise.resolve({
        automation: {
          action: {
            type: 'worktree_pipeline',
            pipeline:
              remoteId === 'automation-hit'
                ? { source: 'shared', remoteId: 'pipeline-1' }
                : {
                    source: 'inline',
                    rawPipeline: 'name: Copy',
                    pipelineContentHash: 'b'.repeat(64),
                  },
          },
        },
      } as unknown as SharedAutomationDetail);
    });

    const result = (await getHandler(PIPELINE_CHANNELS.SHARED_UPDATE_IMPACT)(
      undefined,
      'pipeline-1',
    )) as IPCResult<SharedPipelineSaveImpact>;
    expect(result.success).toBe(true);
    expect(result.data?.automations).toHaveLength(3);
    expect(result.data?.automations).toContainEqual({
      id: 'installed',
      name: 'Installed automation',
      kind: 'installed',
    });
    expect(result.data?.automations).toContainEqual({
      id: 'shared-hit',
      name: 'Shared automation',
      kind: 'shared',
    });
    expect(result.data?.automations).toContainEqual({
      id: 'hidden-shared',
      name: 'Another automation',
      kind: 'shared',
    });
  });

  it('uses the reviewed package upload for an explicit share update', async () => {
    const detail = createSharedPipelineDetail({ id: 'remote-4' });
    mockedUpdateSharedPipeline.mockResolvedValue(detail);
    await expect(
      getHandler(PIPELINE_CHANNELS.SHARED_UPDATE)(undefined, {
        remoteId: 'remote-4',
        rawPipeline: detail.rawPipeline,
        distributionMode: 'package',
        committedPackageUploadId: 'upload-4',
        shareScope: 'public',
      }),
    ).resolves.toEqual({
      success: true,
      data: { ...detail, scopes: ['directory'] },
    });
    expect(mockedUpdateSharedPipeline).toHaveBeenCalledWith(
      'remote-4',
      detail.rawPipeline,
      expect.objectContaining({
        distributionMode: 'package',
        committedPackageUploadId: 'upload-4',
        shareScope: 'public',
      }),
    );
  });

  it('proxies shared pipeline CRUD handlers', async () => {
    const detail = createSharedPipelineDetail({ id: 'remote-2' });
    const scopedDetail = { ...detail, scopes: ['directory'] };
    mockedListSharedPipelines.mockResolvedValue({
      data: [detail],
      nextCursor: 'cursor-2',
    });
    mockedGetSharedPipeline.mockResolvedValue(detail);
    mockedCreateSharedPipeline.mockResolvedValue(detail);
    mockedUpdateSharedPipeline.mockResolvedValue(detail);
    mockedDeleteSharedPipeline.mockResolvedValue(undefined);

    await expect(
      getHandler(PIPELINE_CHANNELS.SHARED_LIST)(undefined, {
        limit: 10,
      }),
    ).resolves.toEqual({
      success: true,
      data: {
        serverId: 'canopy-cloud',
        data: [scopedDetail],
        nextCursor: 'cursor-2',
      },
    });
    await expect(
      getHandler(PIPELINE_CHANNELS.SHARED_GET)(undefined, {
        remoteId: 'remote-2',
      }),
    ).resolves.toEqual({
      success: true,
      data: scopedDetail,
    });
    await expect(
      getHandler(PIPELINE_CHANNELS.SHARED_CREATE)(undefined, {
        rawPipeline: detail.rawPipeline,
      }),
    ).resolves.toEqual({
      success: true,
      data: scopedDetail,
    });
    await expect(
      getHandler(PIPELINE_CHANNELS.SHARED_UPDATE)(undefined, {
        remoteId: 'remote-2',
        rawPipeline: detail.rawPipeline,
      }),
    ).resolves.toEqual({
      success: true,
      data: scopedDetail,
    });
    await expect(
      getHandler(PIPELINE_CHANNELS.SHARED_DELETE)(undefined, {
        remoteId: 'remote-2',
      }),
    ).resolves.toEqual({
      success: true,
    });

    expect(mockedListSharedPipelines).toHaveBeenCalledWith({
      limit: 10,
      cursor: undefined,
      q: undefined,
      triggerType: undefined,
      createdBy: undefined,
    });
    expect(mockedCreateSharedPipeline).toHaveBeenCalledWith({
      rawPipeline: detail.rawPipeline,
      shareScope: undefined,
      teamId: undefined,
      organizationId: undefined,
    });
    // SHARED_GET, plus the update reading the share's distribution mode so a
    // package share is re-packaged rather than demoted.
    expect(mockedGetSharedPipeline).toHaveBeenCalledTimes(2);
    expect(mockedUpdateSharedPipeline).toHaveBeenCalledWith(
      'remote-2',
      detail.rawPipeline,
    );
    expect(mockedDeleteSharedPipeline).toHaveBeenCalledWith('remote-2');

    const publicShare: SharedPipelinePublicShareInfo = {
      externalId: 'public-1',
      pinnedContentHash: 'hash-1',
      upToDate: true,
      sharePath: '/share/pipelines/public-1',
      createdAt: '2026-08-15T00:00:00.000Z',
      updatedAt: '2026-08-15T00:00:00.000Z',
    };
    jest.mocked(publishPipelinePublicShare).mockResolvedValue(publicShare);
    jest.mocked(revokePipelinePublicShare).mockResolvedValue(undefined);

    await expect(
      getHandler(PIPELINE_CHANNELS.SHARED_PUBLIC_PUBLISH)(
        undefined,
        'remote-2',
      ),
    ).resolves.toEqual({ success: true, data: publicShare });
    await expect(
      getHandler(PIPELINE_CHANNELS.SHARED_PUBLIC_REVOKE)(undefined, 'remote-2'),
    ).resolves.toEqual({ success: true });
  });

  it('proxies shared organization and team list handlers', async () => {
    const organization = {
      id: 'org-1',
      name: 'Acme',
      createdAt: '2026-04-26T12:00:00.000Z',
      updatedAt: '2026-04-26T12:00:00.000Z',
    };
    const team = {
      id: 'team-1',
      name: 'Platform',
      organization,
      createdAt: '2026-04-26T12:00:00.000Z',
      updatedAt: '2026-04-26T12:00:00.000Z',
    };
    mockedListSharedOrganizations.mockResolvedValue({ data: [organization] });
    mockedListSharedTeams.mockResolvedValue({ data: [team] });

    await expect(
      getHandler(PIPELINE_CHANNELS.SHARED_ORGANIZATIONS_LIST)(undefined, {
        q: 'ac',
        limit: 20,
      }),
    ).resolves.toEqual({
      success: true,
      data: {
        serverId: 'canopy-cloud',
        data: [organization],
      },
    });
    await expect(
      getHandler(PIPELINE_CHANNELS.SHARED_TEAMS_LIST)(undefined, {
        q: 'plat',
        limit: 10,
      }),
    ).resolves.toEqual({
      success: true,
      data: {
        serverId: 'canopy-cloud',
        data: [team],
      },
    });

    expect(mockedListSharedOrganizations).toHaveBeenCalledWith({
      q: 'ac',
      limit: 20,
    });
    expect(mockedListSharedTeams).toHaveBeenCalledWith({
      q: 'plat',
      limit: 10,
    });
  });

  it.each([
    { sourcePipelineId: 'local-a' },
    { sourcePipeline: { kind: 'stored', id: 'local-a', source: 'user' } },
    {
      sourcePipeline: {
        kind: 'project',
        projectId: 'project-a',
        worktreeId: 'worktree-a',
        pipelineFilePath: '/project/.canopy/pipelines/renamed.yaml',
      },
    },
  ])(
    'forwards the stored share locator %j only while enabled',
    async (source): Promise<void> => {
      mockIsFeatureFlagEnabled.mockReturnValue(true);
      const detail = createSharedPipelineDetail({ id: 'remote-source' });
      mockedCreateSharedPipeline.mockResolvedValue(detail);
      const request = {
        ...source,
        rawPipeline: 'name: Edited',
        shareScope: 'private',
      };
      await getHandler(PIPELINE_CHANNELS.SHARED_CREATE)(undefined, request);
      expect(mockedCreateSharedPipeline).toHaveBeenLastCalledWith(
        expect.objectContaining(source),
      );
      mockedCreateSharedPipeline.mockClear();
      mockIsFeatureFlagEnabled.mockReturnValue(false);
      await getHandler(PIPELINE_CHANNELS.SHARED_CREATE)(undefined, request);
      expect(mockedCreateSharedPipeline).toHaveBeenCalledWith({
        rawPipeline: request.rawPipeline,
        shareScope: 'private',
        teamId: undefined,
        organizationId: undefined,
      });
    },
  );

  it('does not persist a remote link for an immutable bundled snapshot', async () => {
    mockIsFeatureFlagEnabled.mockReturnValue(true);
    mockedCreateSharedPipeline.mockResolvedValue(
      createSharedPipelineDetail({ id: 'remote-bundled' }),
    );

    const result = await getHandler(PIPELINE_CHANNELS.SHARED_CREATE)(
      undefined,
      {
        sourcePipelineId: 'bundled-pipeline',
        sourcePipeline: {
          kind: 'stored',
          id: 'bundled-pipeline',
          source: 'bundled',
        },
        rawPipeline: 'name: Bundled snapshot',
        shareScope: 'private',
      },
    );

    expect(result).toMatchObject({ success: true });
    expect(pipelineService.writePipelineRemoteMetadata).not.toHaveBeenCalled();
  });

  it('persists a remote link for a project pipeline locator', async () => {
    mockIsFeatureFlagEnabled.mockReturnValue(true);
    const detail = createSharedPipelineDetail({ id: 'remote-project' });
    mockedCreateSharedPipeline.mockResolvedValue(detail);
    const pipelineFilePath = '/project/.canopy/pipelines/release.yaml';

    const result = await getHandler(PIPELINE_CHANNELS.SHARED_CREATE)(
      undefined,
      {
        sourcePipeline: {
          kind: 'project',
          projectId: 'project-a',
          worktreeId: 'worktree-a',
          pipelineFilePath,
        },
        rawPipeline: detail.rawPipeline,
        shareScope: 'private',
      },
    );

    expect(result).toMatchObject({ success: true });
    expect(
      (
        pipelineService as typeof pipelineService & {
          writeProjectPipelineRemoteMetadata: jest.Mock;
        }
      ).writeProjectPipelineRemoteMetadata,
    ).toHaveBeenCalledWith(pipelineFilePath, {
      accountId: detail.createdBy.id,
      remoteId: detail.id,
      contentHash: detail.contentHash,
      shareScope: detail.shareScope ?? 'private',
      sharedAt: detail.updatedAt,
    });
  });

  it('deletes a newly created remote pipeline when local link persistence fails', async () => {
    mockIsFeatureFlagEnabled.mockReturnValue(true);
    const detail = createSharedPipelineDetail({ id: 'remote-orphan' });
    mockedCreateSharedPipeline.mockResolvedValue(detail);
    mockedDeleteSharedPipeline.mockResolvedValue(undefined);
    jest
      .mocked(pipelineService.writePipelineRemoteMetadata)
      .mockReturnValueOnce({
        success: false,
        error: 'index is read-only',
      });

    const result = await getHandler(PIPELINE_CHANNELS.SHARED_CREATE)(
      undefined,
      {
        sourcePipelineId: 'local-pipeline',
        rawPipeline: detail.rawPipeline,
        shareScope: 'private',
      },
    );

    // Non-Cloud failures cross IPC with generic structured copy only.
    const genericMessage: unknown = expect.not.stringContaining('read-only');
    const failure: unknown = expect.objectContaining({
      kind: 'unknown',
      message: genericMessage,
    });
    expect(result).toEqual({
      success: false,
      error: 'index is read-only',
      failure,
    });
    expect(mockedDeleteSharedPipeline).toHaveBeenCalledWith('remote-orphan');
  });

  it('keeps a share uncertain when the rollback pre-read fails after the create', async () => {
    mockIsFeatureFlagEnabled.mockReturnValue(true);
    const detail = createSharedPipelineDetail({ id: 'remote-live' });
    mockedCreateSharedPipeline.mockImplementation(() => {
      // The real client marks the create as a sent write.
      noteCloudWriteSent();
      return Promise.resolve(detail);
    });
    const preRead = new CanopyCloudClientError('network-error', 'offline');
    preRead.failedRead = true;
    mockedDeleteSharedPipeline.mockRejectedValue(preRead);
    jest
      .mocked(pipelineService.writePipelineRemoteMetadata)
      .mockReturnValueOnce({
        success: false,
        error: 'index is read-only',
      });

    const result = await getHandler(PIPELINE_CHANNELS.SHARED_CREATE)(
      undefined,
      {
        sourcePipelineId: 'local-pipeline',
        rawPipeline: detail.rawPipeline,
        shareScope: 'private',
      },
    );

    // The pipeline is live and was not rolled back, so a retry would
    // duplicate it.
    const failure: unknown = expect.objectContaining({
      stage: 'publish',
      commitState: 'unknown',
      retryable: false,
    });
    expect(result).toMatchObject({ success: false, failure });
  });

  it('does not delete an existing packaged pipeline when local link persistence fails', async () => {
    mockIsFeatureFlagEnabled.mockReturnValue(true);
    const detail = createSharedPipelineDetail({ id: 'remote-existing' });
    const pipelinePackageService =
      await import('../pipelines/pipeline-package-service');
    const createPackaged = jest
      .spyOn(pipelinePackageService, 'createPackagedSharedPipeline')
      .mockResolvedValue(detail);
    jest
      .mocked(pipelineService.writePipelineRemoteMetadata)
      .mockReturnValueOnce({
        success: false,
        error: 'index is read-only',
      });

    try {
      const result = await getHandler(PIPELINE_CHANNELS.SHARED_CREATE_PACKAGED)(
        undefined,
        {
          analysisId: 'analysis-existing',
          sourcePipelineId: 'local-pipeline',
          remoteId: 'remote-existing',
        },
      );

      const failure: unknown = expect.objectContaining({ kind: 'unknown' });
      expect(result).toEqual({
        success: false,
        error: 'index is read-only',
        failure,
      });
      expect(mockedDeleteSharedPipeline).not.toHaveBeenCalled();
    } finally {
      createPackaged.mockRestore();
    }
  });

  it('sends packaged-share progress to the renderer that invoked the handler', async () => {
    const detail = createSharedPipelineDetail({ id: 'remote-packaged' });
    const invokingWindow = {} as BrowserWindow;
    const originalFromWebContents = Object.getOwnPropertyDescriptor(
      BrowserWindow,
      'fromWebContents',
    );
    const fromWebContents = jest.fn(() => invokingWindow);
    Object.defineProperty(BrowserWindow, 'fromWebContents', {
      configurable: true,
      value: fromWebContents,
    });
    const pipelinePackageService =
      await import('../pipelines/pipeline-package-service');
    const createPackaged = jest
      .spyOn(pipelinePackageService, 'createPackagedSharedPipeline')
      .mockResolvedValue(detail);

    try {
      const event = {
        sender: {
          getOwnerBrowserWindow: jest.fn(() => invokingWindow),
        },
      };

      await getHandler(PIPELINE_CHANNELS.SHARED_CREATE_PACKAGED)(event, {
        analysisId: 'analysis-packaged',
        sourcePipelineId: 'local-pipeline',
      });

      const getWindow = createPackaged.mock.calls[0]?.[1];
      expect(getWindow).toBeDefined();
      expect(getWindow?.()).toBe(invokingWindow);
      expect(fromWebContents).toHaveBeenCalledWith(event.sender);
    } finally {
      createPackaged.mockRestore();
      if (originalFromWebContents) {
        Object.defineProperty(
          BrowserWindow,
          'fromWebContents',
          originalFromWebContents,
        );
      } else {
        Reflect.deleteProperty(BrowserWindow, 'fromWebContents');
      }
    }
  });

  it('forwards shared create ownership scope fields', async () => {
    const detail = createSharedPipelineDetail({ id: 'remote-scope' });
    mockedCreateSharedPipeline.mockResolvedValue(detail);

    await getHandler(PIPELINE_CHANNELS.SHARED_CREATE)(undefined, {
      rawPipeline: detail.rawPipeline,
      shareScope: 'team',
      teamId: 'team-1',
    });
    await getHandler(PIPELINE_CHANNELS.SHARED_CREATE)(undefined, {
      rawPipeline: detail.rawPipeline,
      shareScope: 'organization',
      organizationId: 'org-1',
    });

    expect(mockedCreateSharedPipeline).toHaveBeenNthCalledWith(1, {
      rawPipeline: detail.rawPipeline,
      shareScope: 'team',
      teamId: 'team-1',
      organizationId: undefined,
    });
    expect(mockedCreateSharedPipeline).toHaveBeenNthCalledWith(2, {
      rawPipeline: detail.rawPipeline,
      shareScope: 'organization',
      teamId: undefined,
      organizationId: 'org-1',
    });
    expect(mockedGetSharedPipeline).not.toHaveBeenCalled();
  });

  it('keeps a queued project run file locator without its file path', async () => {
    await getHandler(PIPELINE_CHANNELS.EXECUTE)(
      undefined,
      { name: 'Queued', on: 'dispatch', jobs: { build: { steps: [] } } },
      {
        cwd: repoPath,
        repoPath,
        pipelineId: 'project--queued.yaml',
        pipelinePreferenceLocator: {
          type: 'file',
          value: '/source/.canopy/pipelines/queued.yaml',
        },
      },
    );
    expect(mockExecutePipeline.mock.calls[0]?.[1]).toMatchObject({
      pipelinePreferenceLocator: {
        type: 'file',
        value: '/source/.canopy/pipelines/queued.yaml',
      },
    });
  });

  it('fetches and caches a shared pipeline before execute', async () => {
    const detail = createSharedPipelineDetail({
      id: 'remote-exec',
      name: 'Execute Shared',
    });
    mockedGetSharedPipeline.mockResolvedValue(detail);

    await getHandler(PIPELINE_CHANNELS.EXECUTE)(
      undefined,
      {
        name: 'Stale local copy',
        on: 'dispatch',
        jobs: {
          build: {
            steps: [],
          },
        },
      },
      {
        cwd: repoPath,
        repoPath,
        pipelineId: 'shared:canopy-cloud:remote-exec',
        sharedPipeline: {
          serverId: 'canopy-cloud',
          remoteId: 'remote-exec',
        },
      },
    );

    const executeCall = mockExecutePipeline.mock.calls[0];
    const executeOptions = executeCall?.[1];
    const sharedPipelineSource = executeOptions?.sharedPipelineSource;
    expect(executeCall?.[0]).toMatchObject({
      name: 'Execute Shared',
    });
    expect(executeOptions).toMatchObject({
      pipelinePreferenceLocator: {
        type: 'shared',
        value: 'canopy-cloud:remote-exec',
      },
    });
    expect(sharedPipelineSource).toMatchObject({
      type: 'shared',
      serverId: 'canopy-cloud',
      serverName: 'Canopy Cloud',
      remoteId: 'remote-exec',
    });
    const cachedPath = sharedPipelineSource?.cachedPipelinePath;
    expect(cachedPath).toBeDefined();
    expect(fs.readFileSync(cachedPath ?? '', 'utf8')).toBe(detail.rawPipeline);
  });

  it.each([
    {
      failure: 'a transient Cloud failure',
      error: new CanopyCloudClientError('network-error', 'offline'),
      expected: backgroundExecutionRetryMessage('run'),
    },
    {
      failure: 'a confirmed missing share',
      error: new CanopyCloudClientError(
        'http-error',
        'gone',
        404,
        undefined,
        undefined,
        true,
      ),
      expected: backgroundExecutionDeniedMessage('access-removed'),
    },
    {
      failure: 'an account change during the read',
      error: new Error('Workflow unavailable (access-removed)'),
      expected: backgroundExecutionDeniedMessage('access-removed'),
    },
  ])(
    'classifies $failure at shared background dispatch',
    async ({ error, expected }) => {
      mockBackgroundEnabled.mockReturnValue(true);
      mockedGetSharedPipelineForExecutionContext.mockRejectedValueOnce(error);

      const result = await startPipelineExecutionFromMain({
        pipeline: { name: 'Selection stub', on: 'dispatch', jobs: {} },
        options: {
          cwd: repoPath,
          repoPath,
          projectId: 'project-1',
          pipelineId: 'shared:canopy-cloud:remote-exec',
          initiationSource: 'automation',
          executionContext: 'personal',
          sharedPipeline: { serverId: 'canopy-cloud', remoteId: 'remote-exec' },
        },
        getWindow: () => null,
      });

      expect(result).toEqual({ success: false, error: expected });
      expect(mockExecutePipeline).not.toHaveBeenCalled();
    },
  );

  it.each([
    { enabled: true, allow: true },
    { enabled: true, allow: false },
    { enabled: true, allow: false, transient: true },
    { enabled: false, allow: false },
  ])(
    'authorizes the fetched shared background definition (enabled=$enabled, allow=$allow)',
    async ({ enabled, allow, transient }): Promise<void> => {
      mockBackgroundEnabled.mockReturnValue(enabled);
      mockAuthorizeBackground.mockResolvedValue(
        allow
          ? { allow: true }
          : transient
            ? { allow: false, reason: 'unknown-provenance', transient: true }
            : { allow: false, reason: 'access-removed' },
      );
      const detail = createSharedPipelineDetail({
        id: 'remote-exec',
        shareScope: 'private',
        rawPipeline:
          'name: Shared\non: dispatch\njobs:\n  build:\n    steps:\n      - uses: plugin/action\n',
      });
      mockedGetSharedPipeline.mockResolvedValue(detail);
      const result = await startPipelineExecutionFromMain({
        pipeline: { name: 'Selection stub', on: 'dispatch', jobs: {} },
        options: {
          cwd: repoPath,
          repoPath,
          projectId: 'project-1',
          pipelineId: 'shared:canopy-cloud:remote-exec',
          initiationSource: 'automation',
          executionContext: 'personal',
          sharedPipeline: { serverId: 'canopy-cloud', remoteId: 'remote-exec' },
        },
        getWindow: () => null,
      });
      expect(mockedGetSharedPipelineForExecutionContext).toHaveBeenCalledWith(
        'remote-exec',
      );
      if (enabled && !allow) {
        expect(result).toEqual({
          success: false,
          error: transient
            ? backgroundExecutionRetryMessage('run')
            : backgroundExecutionDeniedMessage('access-removed'),
        });
        expect(mockExecutePipeline).not.toHaveBeenCalled();
      } else {
        expect(result.success).toBe(true);
        expect(mockExecutePipeline).toHaveBeenCalledWith(
          expect.objectContaining({
            jobs: { build: { steps: [{ uses: 'plugin/action' }] } },
          }),
          expect.anything(),
        );
      }
      if (enabled) {
        const privateOwner: unknown = expect.objectContaining({
          shareScope: 'private',
        });
        expect(mockAuthorizeBackground).toHaveBeenCalledWith(
          'personal',
          expect.arrayContaining([
            expect.objectContaining({
              owner: privateOwner,
            }),
            { owner: undefined },
          ]),
          { projectId: 'project-1', worktreeId: undefined },
          expect.any(Array),
        );
      } else {
        expect(mockAuthorizeBackground).not.toHaveBeenCalled();
      }
    },
  );

  it('fails closed when an automation shared-pipeline pin no longer matches', async () => {
    const detail = createSharedPipelineDetail({
      id: 'remote-exec',
      name: 'Changed Shared Pipeline',
    });
    mockedGetSharedPipeline.mockResolvedValue(detail);

    await expect(
      getHandler(PIPELINE_CHANNELS.EXECUTE)(
        undefined,
        {
          name: 'Pinned local copy',
          on: 'dispatch',
          jobs: {},
        },
        {
          cwd: repoPath,
          repoPath,
          pipelineId: 'shared:canopy-cloud:remote-exec',
          sharedPipeline: {
            serverId: 'canopy-cloud',
            remoteId: 'remote-exec',
            installPin: {
              pipelineContentHash: 'a'.repeat(64),
              distributionMode: 'definition_only',
            },
          },
        },
      ),
    ).resolves.toEqual({
      success: false,
      errorCode: 'shared_pipeline_changed',
      error:
        'The pinned version of "Changed Shared Pipeline" could not be verified. Refresh and try again.',
    });
    expect(mockExecutePipeline).not.toHaveBeenCalled();
  });

  it('drops renderer-supplied execution ids and trigger sources from execute requests', async () => {
    await getHandler(PIPELINE_CHANNELS.EXECUTE)(
      undefined,
      {
        name: 'Inline Pipeline',
        on: 'dispatch',
        jobs: {
          build: {
            steps: [],
          },
        },
      },
      {
        cwd: repoPath,
        repoPath,
        pipelineId: 'inline-pipeline',
        executionId: '../unsafe-id',
        triggerSource: {
          kind: 'hook',
          hook_key: 'project:pr:create',
          hook_label: 'PR Created',
          trigger_name: 'pr:create',
          target: 'project',
          action_index: 0,
          triggered_at: '2026-04-30T00:00:00.000Z',
        },
      },
    );

    const executeCall = mockExecutePipeline.mock.calls[0];
    const executeOptions = executeCall?.[1];
    expect(executeOptions?.executionId).toEqual(expect.any(String));
    expect(executeOptions?.executionId).not.toBe('../unsafe-id');
    expect(executeOptions?.triggerSource).toBeUndefined();
  });
});

describe('pipeline-handlers', () => {
  let tempDir: string;
  let getWindow: jest.Mock<BrowserWindow | null, []>;

  beforeEach(() => {
    jest.clearAllMocks();
    mockIsFeatureFlagEnabled.mockImplementation(
      (key: string) => key !== 'canopy-shared-org-projects-enabled',
    );
    registeredHandlers.clear();
    mockBackgroundEnabled.mockReturnValue(false);
    mockAuthorizeBackground.mockResolvedValue({ allow: true });

    tempDir = fs.mkdtempSync(
      path.join(os.tmpdir(), 'canopy-pipeline-handlers-'),
    );
    runtime = {
      // Pipeline fixtures do not enforce an org model policy.
      isModelBlockedByOrgPolicy: (): Promise<boolean> => Promise.resolve(false),
      isOrgModelPolicyActive: (): Promise<boolean> => Promise.resolve(false),
      executionsDir: path.join(tempDir, 'executions'),
      tempRootDir: path.join(tempDir, 'tmp'),
      bundledActionsDir: path.join(tempDir, 'actions'),
      getProjectActionsDir: (repoPath: string): string => repoPath,
      getProjectPipelinesDir: (repoPath: string): string =>
        path.join(repoPath, '.canopy', 'pipelines'),
    };
    fs.mkdirSync(runtime.executionsDir, { recursive: true });
    fs.mkdirSync(runtime.tempRootDir, { recursive: true });
    fs.mkdirSync(runtime.bundledActionsDir, { recursive: true });

    getWindow = jest.fn((): BrowserWindow | null => null);
    mockBuildPipelineBaseBranchEnv.mockResolvedValue({
      CANOPY_BASE_BRANCH: 'develop',
      CANOPY_BASE_BRANCH_EXISTS_IN_REMOTE: 'true',
    });
    mockReadPreferencesFile.mockResolvedValue(makePipelinePreferences());
    mockReadEnvironmentConfig.mockResolvedValue({
      data: createDefaultEnvironmentConfig('2026-05-29T00:00:00.000Z'),
      encryptionAvailable: true,
    });
    mockUpdatePlan.mockResolvedValue(null);
    mockReadTrackedPlanData.mockReset().mockResolvedValue(null);
    registerExecutionHandlers(getWindow);
  });

  afterEach(() => {
    fs.rmSync(tempDir, { recursive: true, force: true });
  });

  function expectLastAdvisorWatchExecution(executionId: string): void {
    const lastCall =
      mockWatchExecution.mock.calls[mockWatchExecution.mock.calls.length - 1];
    const request = lastCall?.[0];
    expect(request?.handle.id).toBe(executionId);
    expect(request?.runtime).toBe(runtime);
    expect(request?.getWindow).toBe(getWindow);
  }

  async function emitPipelineLifecycleEvent(
    state: ExecutionState,
    type: ExecutionEvent['type'],
  ): Promise<void> {
    mockExecutePipeline.mockImplementationOnce(
      (
        _pipeline,
        options: {
          onEvent?: (event: ExecutionEvent) => void;
        },
      ): Promise<ExecutionHandle> => {
        options.onEvent?.({
          executionId: state.id,
          type,
          state,
          timestamp: '2026-05-26T12:30:00.000Z',
        });
        return Promise.resolve(createHandle(state));
      },
    );

    const handler = registeredHandlers.get(PIPELINE_CHANNELS.EXECUTE);
    await handler?.(
      {},
      { name: 'test', on: 'dispatch', jobs: {} },
      {
        cwd: '/workspace/repo',
        pipelineId: state.pipeline_id,
        projectId: state.project_id,
        worktreeId: state.worktree_id,
      },
    );
  }

  it('prioritizes a known PR refresh when a worktree pipeline succeeds', async () => {
    const executionState = createState({
      id: 'exec-success',
      status: 'success',
      project_id: 'project-1',
      worktree_id: 'worktree-1',
      completed_at: '2026-05-26T12:30:00.000Z',
    });

    await emitPipelineLifecycleEvent(executionState, 'execution.completed');

    expect(mockEnqueueKnownPrFastRefresh).toHaveBeenCalledWith(
      'project-1',
      'worktree-1',
    );
  });

  it('prioritizes a known PR refresh when a worktree pipeline fails', async () => {
    const executionState = createState({
      id: 'exec-failure',
      status: 'failure',
      project_id: 'project-1',
      worktree_id: 'worktree-1',
      completed_at: '2026-05-26T12:30:00.000Z',
    });

    await emitPipelineLifecycleEvent(executionState, 'execution.failed');

    expect(mockEnqueueKnownPrFastRefresh).toHaveBeenCalledWith(
      'project-1',
      'worktree-1',
    );
  });

  it('does not prioritize PR refreshes for non-worktree pipeline completions', async () => {
    const executionState = createState({
      id: 'exec-no-worktree',
      status: 'success',
      project_id: 'project-1',
      worktree_id: undefined,
      completed_at: '2026-05-26T12:30:00.000Z',
    });

    await emitPipelineLifecycleEvent(executionState, 'execution.completed');

    expect(mockEnqueueKnownPrFastRefresh).not.toHaveBeenCalled();
  });

  it('injects preference env vars into executePipeline', async () => {
    const executionState = createState({ id: 'exec-1', status: 'pending' });

    mockResolveLinearToken.mockResolvedValue('lin_test');
    mockReadPreferencesFile.mockResolvedValue(
      makePipelinePreferences({
        prGenerationModel: 'claude-sonnet-4-6',
        prGenerationThinkingLevel: 'high',
        prInstructions: 'PR instructions',
        prInstructionMode: 'append',
        commitGenerationModel: 'claude-haiku-4-5-20251001',
        commitGenerationThinkingLevel: 'off',
        commitInstructions: 'Commit instructions',
        commitInstructionMode: 'replace',
        rtkEnabled: true,
        codexMultiAgentPipelinesEnabled: true,
      }),
    );
    mockExecutePipeline.mockResolvedValue(createHandle(executionState));

    const handler = registeredHandlers.get(PIPELINE_CHANNELS.EXECUTE);
    expect(handler).toBeDefined();

    await handler?.(
      {},
      { name: 'test', on: 'dispatch', jobs: {} },
      {
        cwd: '/workspace/repo',
        pipelineId: 'test',
      },
    );

    const executeCall = mockExecutePipeline.mock.calls[0];
    const executeOptions = executeCall?.[1];

    expect(executeOptions).toMatchObject({
      env: {
        CANOPY_PREF_RTK_ENABLED: 'true',
        CANOPY_PREF_CODEX_MULTI_AGENT_PIPELINES_ENABLED: 'true',
        CANOPY_PREF_PR_GENERATION_MODEL: 'claude-sonnet-4-6',
        CANOPY_PREF_PR_GENERATION_THINKING_LEVEL: 'high',
        CANOPY_PREF_PR_INSTRUCTIONS: 'PR instructions',
        CANOPY_PREF_PR_INSTRUCTION_MODE: 'append',
        CANOPY_PREF_COMMIT_GENERATION_MODEL: 'claude-haiku-4-5-20251001',
        CANOPY_PREF_COMMIT_GENERATION_THINKING_LEVEL: 'off',
        CANOPY_PREF_COMMIT_INSTRUCTIONS: 'Commit instructions',
        CANOPY_PREF_COMMIT_INSTRUCTION_MODE: 'replace',
        CANOPY_BASE_BRANCH: 'develop',
        CANOPY_BASE_BRANCH_EXISTS_IN_REMOTE: 'true',
      },
      secretEnv: { CANOPY_LINEAR_API_KEY: 'lin_test' },
    });
    expectLastAdvisorWatchExecution('exec-1');
  });

  it('injects the cached Git executable path into pipeline env', async () => {
    const executionState = createState({ id: 'exec-git' });
    const gitExecutablePath = 'C:\\Program Files\\Git\\cmd\\git.exe';

    mockReadPreferencesFile.mockResolvedValue(
      makePipelinePreferences({ gitExecutablePath }),
    );
    mockExecutePipeline.mockResolvedValue(createHandle(executionState));

    const handler = registeredHandlers.get(PIPELINE_CHANNELS.EXECUTE);
    await handler?.(
      {},
      { name: 'test', on: 'dispatch', jobs: {} },
      {
        cwd: '/workspace/repo',
        pipelineId: 'test',
      },
    );

    expect(mockExecutePipeline.mock.calls[0]?.[1]?.env).toMatchObject({
      CANOPY_GIT_EXECUTABLE: gitExecutablePath,
    });
  });

  it('uses a validated Windows Git path instead of an older preference snapshot', async () => {
    jest
      .mocked(getGitExecutablePlatformStatus)
      .mockReturnValueOnce({ required: true, platform: 'win32' });
    jest
      .mocked(getResolvedGitExecutableForSpawn)
      .mockResolvedValueOnce('C:\\Recovered\\git.exe');
    const executionState = createState({ id: 'exec-git' });
    const gitExecutablePath = 'C:\\Program Files\\Git\\cmd\\git.exe';

    mockReadPreferencesFile.mockResolvedValue(
      makePipelinePreferences({ gitExecutablePath }),
    );
    mockExecutePipeline.mockResolvedValue(createHandle(executionState));

    const handler = registeredHandlers.get(PIPELINE_CHANNELS.EXECUTE);
    await handler?.(
      {},
      { name: 'test', on: 'dispatch', jobs: {} },
      {
        cwd: '/workspace/repo',
        pipelineId: 'test',
      },
    );

    expect(mockExecutePipeline.mock.calls[0]?.[1]?.env).toMatchObject({
      CANOPY_GIT_EXECUTABLE: 'C:\\Recovered\\git.exe',
    });
  });

  it('falls back from terminal-mode pipeline agents when Claude is not authenticated', async () => {
    const executionState = createState({ id: 'exec-auth', status: 'pending' });
    mockReadPreferencesFile.mockResolvedValue(
      makePipelinePreferences({ pipelinesMode: 'terminal' }),
    );
    mockGetCachedClaudeAuthStatusObserved.mockResolvedValueOnce({
      authenticated: false,
      accountLabel: null,
      detail: null,
      error: 'Claude is not authenticated.',
    });
    mockExecutePipeline.mockResolvedValue(createHandle(executionState));

    const handler = registeredHandlers.get(PIPELINE_CHANNELS.EXECUTE);
    await handler?.(
      {},
      { name: 'test', on: 'dispatch', jobs: {} },
      {
        cwd: '/workspace/repo',
        pipelineId: 'test',
      },
    );

    expect(mockExecutePipeline.mock.calls[0]?.[1]).toMatchObject({
      agentTerminalMode: false,
    });
    expect(mockGetCachedClaudeAuthStatusObserved).toHaveBeenCalledWith(
      'pipeline-terminal-mode',
      { forceRefresh: true },
    );
  });

  it('forces pipeline agents to canopy mode when Claude TUI workers are disabled', async () => {
    const executionState = createState({ id: 'exec-flag', status: 'pending' });
    mockReadPreferencesFile.mockResolvedValue(
      makePipelinePreferences({
        canopyBackgroundProcessesMode: 'terminal',
        pipelinesMode: 'terminal',
      }),
    );
    mockIsFeatureFlagEnabled.mockReturnValue(false);
    mockExecutePipeline.mockResolvedValue(createHandle(executionState));

    const handler = registeredHandlers.get(PIPELINE_CHANNELS.EXECUTE);
    await handler?.(
      {},
      { name: 'test', on: 'dispatch', jobs: {} },
      {
        cwd: '/workspace/repo',
        pipelineId: 'test',
      },
    );

    expect(mockExecutePipeline.mock.calls[0]?.[1]).toMatchObject({
      agentTerminalMode: false,
    });
    expect(mockGetCachedClaudeAuthStatusObserved).not.toHaveBeenCalledWith(
      'pipeline-terminal-mode',
      { forceRefresh: true },
    );
  });

  describe('READ_STEP_LOG', () => {
    function stepLogPath(): string {
      return path.join(
        runtime.executionsDir,
        'exec-1',
        'logs',
        'job-1--step-1.log',
      );
    }

    function writeStepLog(content: string | Buffer): string {
      const logFile = stepLogPath();
      fs.mkdirSync(path.dirname(logFile), { recursive: true });
      fs.writeFileSync(logFile, content);
      return logFile;
    }

    async function readStepLog(
      ...args: unknown[]
    ): Promise<IPCResult<StepLogReadResult>> {
      const handler = registeredHandlers.get(PIPELINE_CHANNELS.READ_STEP_LOG);
      const result: unknown = await handler?.({}, ...args);
      if (!isStepLogIpcResult(result)) {
        throw new Error('READ_STEP_LOG returned an unexpected shape');
      }
      return result;
    }

    const locator = {
      executionId: 'exec-1',
      jobId: 'job-1',
      stepId: 'step-1',
    };

    it('keeps the legacy lines result for existing readers', async () => {
      writeStepLog('one\r\ntwo\n');
      await expect(readStepLog(locator)).resolves.toEqual({
        success: true,
        data: { lines: ['one', 'two'], byteLength: 9 },
      });
    });

    it('returns a positioned text snapshot when asked for text', async () => {
      const logFile = writeStepLog('café\n');
      const { generation } = commitWholeStepLog(logFile, 'café\n');
      await expect(readStepLog(locator, { format: 'text' })).resolves.toEqual({
        success: true,
        data: { lines: [], text: 'café\n', byteLength: 6, generation },
      });
    });

    it('treats an unknown format as the default lines read', async () => {
      writeStepLog('one\n');
      await expect(
        readStepLog(locator, { format: 'bytes' }),
      ).resolves.toMatchObject({ success: true, data: { lines: ['one'] } });
    });

    it('reads a missing log as empty', async () => {
      await expect(readStepLog(locator, { format: 'text' })).resolves.toEqual({
        success: true,
        data: { lines: [], text: '', byteLength: 0 },
      });
    });

    it('still rejects a log path outside the executions directory', async () => {
      await expect(
        readStepLog({ ...locator, logFilePath: path.join(tempDir, 'x.log') }),
      ).resolves.toEqual({ success: false, error: 'Invalid log file path' });
    });
  });

  describe('implicit plan approval', () => {
    it.each([
      { eventName: 'plan_ready', planId: 'plan-1' },
      {
        eventName: 'plan_ready',
        eventData: { plan_ready: { planId: 'plan-1' } },
      },
      { initiationSource: 'portal', planId: 'plan-1' },
    ])('refuses Cursor plan execution before launch: %j', async (options) => {
      mockReadTrackedPlanData.mockResolvedValue({
        id: 'plan-1',
        projectId: 'project-1',
        worktreeId: 'worktree-1',
        source: 'cursor',
        title: 'Plan',
        content: '# Plan',
        reviewStatus: 'pending',
        createdAt: '2026-10-15T00:00:00Z',
        updatedAt: '2026-10-15T00:00:00Z',
        latestRevisionNumber: 1,
        revisions: [],
        linkedExecutionIds: [],
      });
      await runPlanReadyExecute({
        projectId: 'project-1',
        worktreeId: 'worktree-1',
        ...options,
      });
      expect(mockExecutePipeline).not.toHaveBeenCalled();
      expect(mockUpdatePlan).not.toHaveBeenCalled();
    });

    async function runPlanReadyExecute(
      options: Record<string, unknown>,
    ): Promise<void> {
      const executionState = createState({
        id: 'exec-plan',
        status: 'running',
      });
      mockExecutePipeline.mockResolvedValue(createHandle(executionState));

      const handler = registeredHandlers.get(PIPELINE_CHANNELS.EXECUTE);
      await handler?.(
        {},
        { name: 'test', on: 'plan_ready', jobs: {} },
        {
          cwd: '/workspace/repo',
          pipelineId: 'test',
          ...options,
        },
      );
    }

    it('approves the plan for a plan_ready run with a top-level planId', async () => {
      await runPlanReadyExecute({
        projectId: 'project-1',
        worktreeId: 'worktree-1',
        eventName: 'plan_ready',
        planId: 'plan-1',
        initiationSource: 'portal',
      });

      expect(mockUpdatePlan).toHaveBeenCalledTimes(1);
      expect(mockUpdatePlan).toHaveBeenCalledWith(
        expect.objectContaining({
          projectId: 'project-1',
          worktreeId: 'worktree-1',
          planId: 'plan-1',
          reviewStatus: 'approved',
          linkedExecutionId: 'exec-plan',
          initiationSource: 'portal',
        }),
      );
      expect(typeof mockUpdatePlan.mock.calls[0]?.[0]?.approvedAt).toBe(
        'string',
      );
    });

    it('resolves the planId from eventData.plan_ready (App Advisor form)', async () => {
      await runPlanReadyExecute({
        projectId: 'project-1',
        worktreeId: 'worktree-1',
        chatId: 'chat-1',
        eventName: 'plan_ready',
        eventData: {
          plan_ready: { plan_text: 'plan body', planId: 'plan-nested' },
        },
      });

      expect(mockUpdatePlan).toHaveBeenCalledTimes(1);
      expect(mockUpdatePlan).toHaveBeenCalledWith(
        expect.objectContaining({
          planId: 'plan-nested',
          reviewStatus: 'approved',
          linkedExecutionId: 'exec-plan',
          chatId: 'chat-1',
          initiationSource: 'user',
        }),
      );
    });

    it('does not approve when the event is not plan_ready', async () => {
      const executionState = createState({
        id: 'exec-dispatch',
        status: 'running',
      });
      mockExecutePipeline.mockResolvedValue(createHandle(executionState));

      const handler = registeredHandlers.get(PIPELINE_CHANNELS.EXECUTE);
      await handler?.(
        {},
        { name: 'test', on: 'dispatch', jobs: {} },
        {
          cwd: '/workspace/repo',
          pipelineId: 'test',
          projectId: 'project-1',
          worktreeId: 'worktree-1',
          eventName: 'dispatch',
          planId: 'plan-1',
        },
      );

      expect(mockUpdatePlan).not.toHaveBeenCalled();
    });

    it('approves a Portal run that forwards planId without an eventName', async () => {
      const executionState = createState({
        id: 'exec-portal',
        status: 'running',
      });
      mockExecutePipeline.mockResolvedValue(createHandle(executionState));

      const handler = registeredHandlers.get(PIPELINE_CHANNELS.EXECUTE);
      await handler?.(
        {},
        { name: 'test', on: 'dispatch', jobs: {} },
        {
          cwd: '/workspace/repo',
          pipelineId: 'test',
          projectId: 'project-1',
          worktreeId: 'worktree-1',
          // Portal `runPipeline` payloads carry no eventName.
          planId: 'plan-portal',
          initiationSource: 'portal',
        },
      );

      expect(mockUpdatePlan).toHaveBeenCalledTimes(1);
      expect(mockUpdatePlan).toHaveBeenCalledWith(
        expect.objectContaining({
          planId: 'plan-portal',
          reviewStatus: 'approved',
          linkedExecutionId: 'exec-portal',
          initiationSource: 'portal',
        }),
      );
    });

    it('does not approve when no planId resolves', async () => {
      await runPlanReadyExecute({
        projectId: 'project-1',
        worktreeId: 'worktree-1',
        eventName: 'plan_ready',
      });

      expect(mockUpdatePlan).not.toHaveBeenCalled();
    });

    it('does not approve when project/worktree context is missing', async () => {
      await runPlanReadyExecute({
        eventName: 'plan_ready',
        planId: 'plan-1',
      });

      expect(mockUpdatePlan).not.toHaveBeenCalled();
    });

    it('records a diagnostic but still succeeds when approval throws', async () => {
      mockUpdatePlan.mockRejectedValueOnce(new Error('persist failed'));
      const executionState = createState({
        id: 'exec-plan-fail',
        status: 'running',
      });
      mockExecutePipeline.mockResolvedValue(createHandle(executionState));

      const handler = registeredHandlers.get(PIPELINE_CHANNELS.EXECUTE);
      const result = await handler?.(
        {},
        { name: 'test', on: 'plan_ready', jobs: {} },
        {
          cwd: '/workspace/repo',
          pipelineId: 'test',
          projectId: 'project-1',
          worktreeId: 'worktree-1',
          eventName: 'plan_ready',
          planId: 'plan-1',
        },
      );

      expect(result).toMatchObject({ success: true });
      expect(mockRecordAppDiagnostic).toHaveBeenCalledWith(
        expect.objectContaining({
          kind: 'implicit_plan_approval_failed',
          error: 'persist failed',
        }),
      );
    });
  });

  it('falls back to no runtime env when environment config cannot be read', async () => {
    const executionState = createState({ id: 'exec-env-fallback' });
    mockReadEnvironmentConfig.mockRejectedValueOnce(
      new Error('environment read failed'),
    );
    mockExecutePipeline.mockResolvedValue(createHandle(executionState));

    const handler = registeredHandlers.get(PIPELINE_CHANNELS.EXECUTE);
    await handler?.(
      {},
      { name: 'test', on: 'dispatch', jobs: {} },
      {
        cwd: '/workspace/repo',
        pipelineId: 'test',
      },
    );

    const executeOptions = mockExecutePipeline.mock.calls[0]?.[1];
    expect(executeOptions?.env).toMatchObject({
      CANOPY_PREF_RTK_ENABLED: 'true',
      CANOPY_BASE_BRANCH: 'develop',
      CANOPY_BASE_BRANCH_EXISTS_IN_REMOTE: 'true',
    });
    expect(executeOptions?.env).not.toHaveProperty('PIPELINE_ONLY');
    expectLastAdvisorWatchExecution('exec-env-fallback');
  });

  it('returns advisor snapshots through GET_ADVISOR and LIST_ADVISORS', async () => {
    await writePipelineAdvisorSnapshot(runtime.executionsDir, {
      version: 1,
      executionId: 'exec-advisor',
      executionDataDir: path.join(runtime.executionsDir, 'exec-advisor'),
      stateFilePath: path.join(runtime.executionsDir, 'exec-advisor.json'),
      provider: 'codex',
      model: 'gpt-6-luna',
      thinkingLevel: 'high',
      sdkSessionId: 'thread-1',
      status: 'waiting',
      turnCount: 1,
      backoffIndex: 1,
      lastUpdatedAt: '2026-05-13T00:00:00.000Z',
      reports: [],
    });

    await expect(
      getHandler(PIPELINE_CHANNELS.GET_ADVISOR)(undefined, 'exec-advisor'),
    ).resolves.toMatchObject({
      success: true,
      data: { executionId: 'exec-advisor', sdkSessionId: 'thread-1' },
    });
    await expect(
      getHandler(PIPELINE_CHANNELS.LIST_ADVISORS)(undefined, ['exec-advisor']),
    ).resolves.toMatchObject({
      success: true,
      data: [{ executionId: 'exec-advisor' }],
    });
  });

  it('starts an on-demand advisor run for an existing execution', async () => {
    mockRunForExistingExecution.mockResolvedValue({
      version: 1,
      executionId: 'exec-advisor',
      executionDataDir: path.join(runtime.executionsDir, 'exec-advisor'),
      stateFilePath: path.join(runtime.executionsDir, 'exec-advisor.json'),
      provider: 'codex',
      model: 'gpt-6-luna',
      thinkingLevel: 'high',
      status: 'starting',
      turnCount: 0,
      backoffIndex: 0,
      lastUpdatedAt: '2026-05-13T00:00:00.000Z',
      reports: [],
    });

    await expect(
      getHandler(PIPELINE_CHANNELS.RUN_ADVISOR)(undefined, 'exec-advisor'),
    ).resolves.toMatchObject({
      success: true,
      data: { executionId: 'exec-advisor', status: 'starting' },
    });
    const runAdvisorRequest = mockRunForExistingExecution.mock.calls[0]?.[0];
    expect(runAdvisorRequest?.executionId).toBe('exec-advisor');
    expect(runAdvisorRequest?.runtime.executionsDir).toBe(
      runtime.executionsDir,
    );
    expect(runAdvisorRequest?.getWindow).toBe(getWindow);
  });

  it('validates advisor IPC inputs', async () => {
    await expect(
      getHandler(PIPELINE_CHANNELS.RUN_ADVISOR)(undefined, ''),
    ).resolves.toMatchObject({
      success: false,
      error: 'executionId is required',
    });
    await expect(
      getHandler(PIPELINE_CHANNELS.GET_ADVISOR)(undefined, ''),
    ).resolves.toMatchObject({
      success: false,
      error: 'executionId is required',
    });
    await expect(
      getHandler(PIPELINE_CHANNELS.LIST_ADVISORS)(undefined, ['valid', '']),
    ).resolves.toMatchObject({
      success: false,
      error: 'executionIds must be an array of non-empty strings',
    });
    await expect(
      getHandler(PIPELINE_CHANNELS.GET_ADVISOR)(undefined, '../outside'),
    ).resolves.toMatchObject({
      success: false,
      error: 'Invalid executionId: must be lowercase alphanumeric with hyphens',
    });
    await expect(
      getHandler(PIPELINE_CHANNELS.LIST_ADVISORS)(undefined, [
        'valid',
        '../outside',
      ]),
    ).resolves.toMatchObject({
      success: false,
      error: 'Invalid executionId: must be lowercase alphanumeric with hyphens',
    });
  });

  it('injects CANOPY_PREF_RTK_ENABLED=false when the preference is disabled', async () => {
    const executionState = createState({ id: 'exec-rtk-disabled' });

    mockResolveLinearToken.mockResolvedValue(null);
    mockReadPreferencesFile.mockResolvedValue(
      makePipelinePreferences({
        rtkEnabled: false,
        codexMultiAgentPipelinesEnabled: false,
        codexMaxConcurrentSubagents: 2,
      }),
    );
    mockExecutePipeline.mockResolvedValue(createHandle(executionState));

    const handler = registeredHandlers.get(PIPELINE_CHANNELS.EXECUTE);
    await handler?.(
      {},
      { name: 'test', on: 'dispatch', jobs: {} },
      {
        cwd: '/workspace/repo',
        pipelineId: 'test',
      },
    );

    const executeCall = mockExecutePipeline.mock.calls[0];
    expect(executeCall?.[1]?.env).toMatchObject({
      CANOPY_PREF_RTK_ENABLED: 'false',
      CANOPY_PREF_CODEX_MULTI_AGENT_PIPELINES_ENABLED: 'false',
      CANOPY_PREF_CODEX_MAX_CONCURRENT_SUBAGENTS: '2',
    });
  });

  it('emits execution.cancelled when the shared main path cancels a stored paused execution', async () => {
    const cancelledState = createState({
      id: 'exec-paused',
      status: 'cancelled',
    });
    mockCancelPipelineExecution.mockResolvedValueOnce(cancelledState);

    const result = await cancelPipelineExecutionFromMain({
      executionId: cancelledState.id,
      getWindow,
    });

    expect(result).toBe(cancelledState);
    expect(mockCancelPipelineExecution).toHaveBeenCalledWith(
      cancelledState.id,
      runtime,
    );
    expect(mockSendToAllWindows).toHaveBeenCalledWith(
      PIPELINE_CHANNELS.EXECUTION_EVENT,
      expect.objectContaining({
        executionId: cancelledState.id,
        type: 'execution.cancelled',
        state: cancelledState,
      }),
    );
  });

  it('falls back to persisted cancellation when an active handle does not settle', async () => {
    const runningState = createState({
      id: 'exec-unresponsive-active',
      status: 'running',
    });
    const cancelledState = createState({
      id: runningState.id,
      status: 'cancelled',
    });
    const cancelDeferred = createDeferred<ExecutionState>();
    const completionDeferred = createDeferred<ExecutionState>();
    const cancel = jest.fn(() => cancelDeferred.promise);
    const handle: ExecutionHandle = {
      id: runningState.id,
      cancel,
      getState: () => runningState,
      waitForCompletion: () => completionDeferred.promise,
    };
    reserveExecution(handle.id);
    trackExecution(handle);
    mockCancelPipelineExecution.mockResolvedValueOnce(cancelledState);

    const request = cancelPipelineExecutionFromMain({
      executionId: handle.id,
      getWindow,
    });

    try {
      // The persisted path settles the request while the handle's own cancel
      // is still pending.
      await expect(request).resolves.toBe(cancelledState);
      expect(cancel).toHaveBeenCalledTimes(1);
      expect(mockCancelPipelineExecution).toHaveBeenCalledWith(
        handle.id,
        runtime,
      );
    } finally {
      cancelDeferred.resolve(cancelledState);
      completionDeferred.resolve(cancelledState);
      await request;
      await completionDeferred.promise;
      await Promise.resolve();
      mockCancelPipelineExecution.mockReset();
    }
  });

  it('retires paused Ledger agents before cancelling, after an owner commit in flight', async () => {
    const owners = getLedgerPipelineAgentOwners();
    const parent = createState({
      id: 'exec-ledger-cancel',
      status: 'paused',
      status_reasons: [],
      pending_pauses: [],
      jobs: {
        build: {
          status: 'paused',
          outputs: {},
          steps: {
            nested: {
              status: 'paused',
              outputs: {},
              dynamic_env: {},
              child_execution_id: 'exec-ledger-cancel-child',
            },
          },
        },
      },
    });
    const cancelledState = createState({ id: parent.id, status: 'cancelled' });
    mockLoadExecutionState.mockImplementation((executionId) =>
      Promise.resolve(executionId === parent.id ? parent : null),
    );
    mockCancelPipelineExecution.mockResolvedValueOnce(cancelledState);
    for (const [agentSessionId, executionId] of [
      ['agent-parent', parent.id],
      ['agent-nested', 'exec-ledger-cancel-child'],
    ]) {
      owners.notePaused({
        agentSessionId,
        displayName: agentSessionId,
        executionId,
        jobId: 'build',
        stepId: 'agent',
        attempt: 1,
        container: {
          kind: 'code_worktree',
          workspaceId: 'workspace-1',
          worktreeId: 'worktree-1',
        },
        checkpointId: `${agentSessionId}-checkpoint`,
        pausedAt: null,
      });
    }
    // An owner commit checking the nested agent holds its execution's fence.
    let releaseCommit: () => void = (): void => undefined;
    const commit = owners.withAdmission(
      'exec-ledger-cancel-child',
      () =>
        new Promise<void>((resolve) => {
          releaseCommit = resolve;
        }),
    );

    const request = cancelPipelineExecutionFromMain({
      executionId: parent.id,
      getWindow,
    });
    for (let tick = 0; tick < 20; tick += 1) await Promise.resolve();

    try {
      // Nothing is cancelled until the commit finishes.
      expect(owners.find('agent-parent')).toBeUndefined();
      expect(owners.find('agent-nested')).toBeDefined();
      expect(mockCancelPipelineExecution).not.toHaveBeenCalled();
    } finally {
      releaseCommit();
      await commit;
    }
    await expect(request).resolves.toBe(cancelledState);
    expect(owners.find('agent-nested')).toBeUndefined();
    expect(mockCancelPipelineExecution).toHaveBeenCalledWith(
      parent.id,
      runtime,
    );
    mockLoadExecutionState.mockReset();
  });

  it('emits execution.cancelled for non-active cancel requests that cancel', async () => {
    const cancelledState = createState({
      id: 'exec-cancelled',
      status: 'cancelled',
    });
    mockCancelPipelineExecution.mockResolvedValueOnce(cancelledState);

    const handler = registeredHandlers.get(PIPELINE_CHANNELS.CANCEL_EXECUTION);
    const result = await handler?.({}, cancelledState.id);

    expect(mockCancelPipelineExecution).toHaveBeenCalledWith(
      cancelledState.id,
      runtime,
    );
    expect(result).toEqual({
      success: true,
      data: cancelledState,
    });
    expect(mockSendToAllWindows).toHaveBeenCalledWith(
      PIPELINE_CHANNELS.EXECUTION_EVENT,
      expect.objectContaining({
        executionId: cancelledState.id,
        type: 'execution.cancelled',
        state: cancelledState,
      }),
    );
    expect(mockSyncPipelineExecutionState).toHaveBeenCalledWith(cancelledState);
    expect(mockHandlePipelineTerminalEvent).toHaveBeenCalledWith(
      expect.objectContaining({
        executionId: cancelledState.id,
        state: cancelledState,
      }),
    );
  });

  it('registers matrix retry and variant-cancellation handlers', () => {
    expect(registeredHandlers.has(PIPELINE_CHANNELS.RETRY_MATRIX_JOB)).toBe(
      true,
    );
    expect(
      registeredHandlers.has(PIPELINE_CHANNELS.CANCEL_MATRIX_VARIANT),
    ).toBe(true);
  });

  it('validates renderer-controlled matrix action identifiers', async () => {
    await expect(
      getHandler(PIPELINE_CHANNELS.CANCEL_MATRIX_VARIANT)(undefined, {
        executionId: 'execution-1',
        jobId: '../process',
        variantJobId: '__matrix__process__0',
      }),
    ).rejects.toThrow(
      'Invalid jobId "../process": identifiers must start with a letter or underscore',
    );
    await expect(
      getHandler(PIPELINE_CHANNELS.RETRY_MATRIX_JOB)(undefined, {
        executionId: '../execution',
        jobId: 'process',
        mode: 'failed',
      }),
    ).rejects.toThrow(
      'Invalid executionId: must be lowercase alphanumeric with hyphens',
    );

    mockLoadExecutionState.mockResolvedValue(null);
    await expect(
      getHandler(PIPELINE_CHANNELS.RETRY_MATRIX_JOB)(undefined, {
        executionId: 'execution-1',
        jobId: 'legacy-review',
        variantJobIds: ['__matrix__legacy-review__0'],
        mode: 'selected',
      }),
    ).rejects.toThrow('Execution "execution-1" not found');
    await expect(
      getHandler(PIPELINE_CHANNELS.CANCEL_MATRIX_VARIANT)(undefined, {
        executionId: 'execution-1',
        jobId: 'legacy-review',
        variantJobId: '__matrix__legacy-review__0',
      }),
    ).rejects.toThrow('Execution "execution-1" not found');
  });

  it('denies a matrix replay after organization access is removed', async (): Promise<void> => {
    const state = actualExecutorModule.createInitialState(
      normalizePipeline({
        name: 'Matrix retry',
        on: 'dispatch',
        jobs: {
          review: {
            strategy: { matrix: { provider: ['claude'] } },
            steps: [{ run: 'echo review' }],
          },
        },
      }),
      {
        cwd: tempDir,
        runtime,
        pipelineId: 'matrix-retry',
        projectId: 'project-1',
        executionContext: 'org:aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa',
      },
      'matrix-retry-execution',
    );
    state.status = 'failure';
    for (const job of Object.values(state.jobs)) {
      job.status = 'failure';
      job.outcome = 'failure';
      job.conclusion = 'failure';
    }
    state.job_groups.review.status = 'failure';
    state.job_groups.review.outcome = 'failure';
    state.job_groups.review.conclusion = 'failure';
    mockLoadExecutionState.mockResolvedValue(state);
    mockRetryMatrixJobExecution.mockResolvedValue(createHandle(state));
    mockBackgroundEnabled.mockReturnValue(true);
    mockAuthorizeBackground.mockResolvedValue({
      allow: false,
      reason: 'access-removed',
    });
    const handler = getHandler(PIPELINE_CHANNELS.RETRY_MATRIX_JOB);
    await expect(
      handler(undefined, {
        executionId: state.id,
        jobId: 'review',
        mode: 'failed',
      }),
    ).rejects.toThrow(backgroundExecutionDeniedMessage('access-removed'));
    expect(mockRetryMatrixJobExecution).not.toHaveBeenCalled();
  });

  it.each(['retry', 'matrix', 'rerun'])(
    'persists the authorized organization on a legacy %s replay',
    async (mode): Promise<void> => {
      const state = actualExecutorModule.createInitialState(
        normalizePipeline({
          name: 'Legacy replay',
          on: 'dispatch',
          scope: ['directory'],
          jobs: {
            review: {
              strategy: { matrix: { provider: ['claude'] } },
              steps: [{ run: 'echo review' }],
            },
          },
        }),
        {
          cwd: tempDir,
          runtime,
          pipelineId: 'legacy-replay',
          scope: 'directory',
        },
        'legacy-replay',
      );
      state.status = 'failure';
      for (const job of Object.values(state.jobs)) {
        job.status = 'failure';
        job.outcome = 'failure';
        job.conclusion = 'failure';
      }
      state.job_groups.review.status = 'failure';
      state.job_groups.review.outcome = 'failure';
      state.job_groups.review.conclusion = 'failure';
      await actualExecutorModule.saveExecutionState(
        state,
        runtime.executionsDir,
      );
      const options = {
        cwd: tempDir,
        runtime,
        executionContext: 'org:aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa',
      };
      const handle =
        mode === 'retry'
          ? await actualExecutorModule.retryPipelineExecution(state.id, options)
          : mode === 'matrix'
            ? await actualExecutorModule.retryMatrixJobExecution(
                { executionId: state.id, jobId: 'review', mode: 'failed' },
                options,
              )
            : await actualExecutorModule.rerunPipelineExecution(
                state.id,
                options,
              );
      await handle.waitForCompletion();
      const persisted = await actualExecutorModule.loadExecutionState(
        handle.id,
        runtime.executionsDir,
      );
      expect(persisted?.execution_context).toBe(options.executionContext);
    },
  );

  it('binds a legacy matrix replay to the authorized organization', async (): Promise<void> => {
    const state = actualExecutorModule.createInitialState(
      normalizePipeline({
        name: 'Matrix retry',
        on: 'dispatch',
        jobs: {
          review: {
            strategy: { matrix: { provider: ['claude'] } },
            steps: [{ run: 'echo review' }],
          },
        },
      }),
      {
        cwd: tempDir,
        runtime,
        pipelineId: 'matrix-retry',
        projectId: 'project-1',
      },
      'matrix-retry-execution',
    );
    state.status = 'failure';
    for (const job of Object.values(state.jobs)) {
      job.status = 'failure';
      job.outcome = 'failure';
      job.conclusion = 'failure';
    }
    state.job_groups.review.status = 'failure';
    state.job_groups.review.outcome = 'failure';
    state.job_groups.review.conclusion = 'failure';
    mockLoadExecutionState.mockResolvedValue(state);
    mockRetryMatrixJobExecution.mockResolvedValue(createHandle(state));
    mockBackgroundEnabled.mockReturnValue(true);
    mockAuthorizeBackground.mockResolvedValue({ allow: true });
    const handler = getHandler(PIPELINE_CHANNELS.RETRY_MATRIX_JOB);
    await handler(undefined, {
      executionId: state.id,
      jobId: 'review',
      mode: 'failed',
    });
    expect(
      mockRetryMatrixJobExecution.mock.calls[0]?.[1].executionContext,
    ).toBe('org:aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa');
  });

  it('reapplies replay guards and base-branch env for matrix retries', async () => {
    const legacyPipeline: Pipeline = {
      name: 'Matrix retry',
      on: 'dispatch',
      jobs: {
        review: {
          strategy: { matrix: { provider: ['claude', 'codex'] } },
          steps: [{ id: 'review', run: 'echo review' }],
        },
      },
    };
    // Preserve legacy replay metadata supplied to normalization at runtime.
    Reflect.set(legacyPipeline, 'job_definitions', {
      build: {
        name: 'Build',
        needs: [],
        timeout_minutes: 360,
        max_retries: 0,
        continue_on_error: false,
        physical_job_id: 'build',
        logical_job_id: 'build',
        steps: [
          {
            id: 'agent',
            uses: 'builtin/agent-prompt',
            shell: 'bash',
            continue_on_error: false,
            timeout_minutes: 360,
            skip_on_missing_action: false,
          },
          {
            id: 'hinted',
            uses: 'project/custom-agent',
            log_format_hint: 'agent',
            shell: 'bash',
            continue_on_error: false,
            timeout_minutes: 360,
            skip_on_missing_action: false,
          },
          {
            id: 'shell',
            run: 'echo ok',
            shell: 'bash',
            continue_on_error: false,
            timeout_minutes: 360,
            skip_on_missing_action: false,
          },
        ],
      },
    });
    const normalized = normalizePipeline(legacyPipeline);
    const state = actualExecutorModule.createInitialState(
      normalized,
      {
        cwd: tempDir,
        repoPath: tempDir,
        pipelineId: 'matrix-retry',
        scope: 'worktree',
        projectId: 'matrix-project',
        worktreeId: 'matrix-worktree',
        runtime,
      },
      'matrix-retry-execution',
    );
    state.status = 'failure';
    state.completed_at = new Date().toISOString();
    const [failedVariantId, successfulVariantId] =
      state.job_groups.review.variant_job_ids;
    state.jobs[failedVariantId].status = 'failure';
    state.jobs[failedVariantId].outcome = 'failure';
    state.jobs[failedVariantId].conclusion = 'failure';
    state.jobs[successfulVariantId].status = 'success';
    state.jobs[successfulVariantId].outcome = 'success';
    state.jobs[successfulVariantId].conclusion = 'success';
    state.job_groups.review.status = 'failure';
    state.job_groups.review.outcome = 'failure';
    state.job_groups.review.conclusion = 'failure';
    mockLoadExecutionState.mockResolvedValue(state);
    mockResolveWorktreeCwd.mockReturnValue(tempDir);
    mockRetryMatrixJobExecution.mockResolvedValue(createHandle(state));

    const handler = getHandler(PIPELINE_CHANNELS.RETRY_MATRIX_JOB);
    await expect(
      handler(undefined, {
        executionId: state.id,
        jobId: 'review',
        mode: 'failed',
      }),
    ).resolves.toBe(state);

    expect(mockReservePipelineExecutionStart).toHaveBeenCalledTimes(1);
    expect(mockReleasePipelineResourceGuard).toHaveBeenCalledTimes(1);
    expect(mockWithWorkspaceTargetRuntimeStartReservation).toHaveBeenCalledWith(
      'matrix-project',
      'matrix-worktree',
      expect.any(Function),
    );
    expect(mockBuildPipelineBaseBranchEnv).toHaveBeenCalledWith({
      cwd: tempDir,
      projectId: 'matrix-project',
      worktreeId: 'matrix-worktree',
    });
    const retryCall = mockRetryMatrixJobExecution.mock.calls[0];
    expect(retryCall?.[0]).toMatchObject({
      executionId: state.id,
      jobId: 'review',
    });
    expect(retryCall?.[1].env).toMatchObject({
      CANOPY_BASE_BRANCH: 'develop',
      CANOPY_BASE_BRANCH_EXISTS_IN_REMOTE: 'true',
    });
    releaseExecutionReservation(state.id);
  });

  it('restarts pending work after cancelling the final persisted blocker', async () => {
    const normalized = normalizePipeline({
      name: 'Persisted matrix cancellation',
      on: 'dispatch',
      jobs: {
        review: {
          strategy: { matrix: { provider: ['claude', 'codex'] } },
          steps: [{ id: 'review', run: 'echo review' }],
        },
        publish: {
          needs: 'review',
          steps: [{ id: 'publish', run: 'echo publish' }],
        },
      },
    });
    const source = actualExecutorModule.createInitialState(
      normalized,
      {
        cwd: tempDir,
        pipelineId: 'persisted-matrix-cancellation',
        runtime,
      },
      'persisted-matrix-cancellation-execution',
    );
    const [pausedVariantId, successfulVariantId] =
      source.job_groups.review.variant_job_ids;
    source.status = 'paused';
    source.jobs[pausedVariantId].status = 'paused';
    source.jobs[pausedVariantId].steps.review.status = 'paused';
    source.jobs[pausedVariantId].steps.review.pause_requested = true;
    source.jobs[successfulVariantId].status = 'success';
    source.jobs[successfulVariantId].outcome = 'success';
    source.jobs[successfulVariantId].conclusion = 'success';
    source.job_groups.review.status = 'paused';

    let persisted = source;
    mockLoadExecutionState.mockImplementation(() => Promise.resolve(persisted));
    mockSaveExecutionState.mockImplementation((state) => {
      persisted = state;
      return Promise.resolve();
    });
    mockResumePipeline.mockImplementation(() => {
      const running = structuredClone(persisted);
      running.status = 'running';
      return Promise.resolve(createHandle(running));
    });

    const result = await cancelMatrixVariantFromMain({
      request: {
        executionId: source.id,
        jobId: 'review',
        variantJobId: pausedVariantId,
      },
      getWindow,
    });

    expect(result.status).toBe('running');
    expect(mockResumePipeline).toHaveBeenCalledWith(
      source.id,
      expect.objectContaining({ initiationSource: source.initiation_source }),
    );
    expect(persisted.jobs[pausedVariantId].status).toBe('cancelled');
  });

  it('restores a resumable state when persisted cancellation restart fails', async () => {
    const normalized = normalizePipeline({
      name: 'Failed persisted matrix restart',
      on: 'dispatch',
      jobs: {
        review: {
          strategy: { matrix: { provider: ['claude'] } },
          steps: [{ id: 'review', run: 'echo review' }],
        },
        publish: {
          needs: 'review',
          steps: [{ id: 'publish', run: 'echo publish' }],
        },
      },
    });
    const source = actualExecutorModule.createInitialState(
      normalized,
      {
        cwd: tempDir,
        pipelineId: 'failed-persisted-matrix-restart',
        runtime,
      },
      'failed-persisted-matrix-restart-execution',
    );
    const [pausedVariantId] = source.job_groups.review.variant_job_ids;
    source.status = 'paused';
    source.jobs[pausedVariantId].status = 'paused';
    source.jobs[pausedVariantId].steps.review.status = 'paused';
    source.jobs[pausedVariantId].steps.review.pause_requested = true;
    source.job_groups.review.status = 'paused';

    let persisted = source;
    mockLoadExecutionState.mockImplementation(() => Promise.resolve(persisted));
    mockSaveExecutionState.mockImplementation((state) => {
      persisted = state;
      return Promise.resolve();
    });
    mockResumePipeline.mockRejectedValue(new Error('restart failed'));

    await expect(
      cancelMatrixVariantFromMain({
        request: {
          executionId: source.id,
          jobId: 'review',
          variantJobId: pausedVariantId,
        },
        getWindow,
      }),
    ).rejects.toThrow('restart failed');
    expect(persisted.status).toBe('paused');
    expect(persisted.completed_at).toBeUndefined();
    expect(persisted.jobs[pausedVariantId].status).toBe('cancelled');
  });

  it('refuses persisted cancellation for an execution owned by a live CLI process', async () => {
    const normalized = normalizePipeline({
      name: 'CLI-owned matrix cancellation',
      on: 'dispatch',
      jobs: {
        review: {
          strategy: { matrix: { provider: ['claude'] } },
          steps: [{ id: 'review', run: 'echo review' }],
        },
      },
    });
    const source = actualExecutorModule.createInitialState(
      normalized,
      {
        cwd: tempDir,
        pipelineId: 'cli-owned-matrix-cancellation',
        runtime,
      },
      'cli-owned-matrix-cancellation-execution',
    );
    const [variantJobId] = source.job_groups.review.variant_job_ids;
    source.status = 'running';
    source.owner_pid = process.pid + 1;
    mockLoadExecutionState.mockResolvedValue(source);
    const processKillSpy = jest.spyOn(process, 'kill').mockReturnValue(true);

    try {
      await expect(
        cancelMatrixVariantFromMain({
          request: {
            executionId: source.id,
            jobId: 'review',
            variantJobId,
          },
          getWindow,
        }),
      ).rejects.toThrow('is owned by another process');
      expect(mockSaveExecutionState).not.toHaveBeenCalled();
      expect(mockResumePipeline).not.toHaveBeenCalled();
    } finally {
      processKillSpy.mockRestore();
    }
  });

  it('refuses a matrix retry while its worktree is split-locked', async () => {
    const normalized = normalizePipeline({
      name: 'Locked matrix retry',
      on: 'dispatch',
      jobs: {
        review: {
          strategy: { matrix: { provider: ['claude'] } },
          steps: [{ id: 'review', run: 'echo review' }],
        },
      },
    });
    const state = actualExecutorModule.createInitialState(
      normalized,
      {
        cwd: tempDir,
        repoPath: tempDir,
        pipelineId: 'locked-matrix-retry',
        scope: 'worktree',
        projectId: 'locked-matrix-project',
        worktreeId: 'locked-matrix-worktree',
        runtime,
      },
      'locked-matrix-retry-execution',
    );
    state.status = 'failure';
    state.completed_at = new Date().toISOString();
    state.job_groups.review.status = 'failure';
    state.job_groups.review.outcome = 'failure';
    state.job_groups.review.conclusion = 'failure';
    mockLoadExecutionState.mockResolvedValue(state);
    acquireSplitLock('locked-matrix-project', 'locked-matrix-worktree');

    try {
      await expect(
        getHandler(PIPELINE_CHANNELS.RETRY_MATRIX_JOB)(undefined, {
          executionId: state.id,
          jobId: 'review',
          mode: 'failed',
        }),
      ).rejects.toThrow('locked while a Split PR is in progress');
      expect(mockRetryMatrixJobExecution).not.toHaveBeenCalled();
    } finally {
      releaseSplitLock('locked-matrix-project', 'locked-matrix-worktree');
    }
  });

  it('emits execution.updated for non-active cancel requests that already finished', async () => {
    const completedState = createState({
      id: 'exec-completed',
      status: 'success',
    });
    mockCancelPipelineExecution.mockResolvedValueOnce(completedState);

    const handler = registeredHandlers.get(PIPELINE_CHANNELS.CANCEL_EXECUTION);
    const result = await handler?.({}, completedState.id);

    expect(mockCancelPipelineExecution).toHaveBeenCalledWith(
      completedState.id,
      runtime,
    );
    expect(result).toEqual({
      success: true,
      data: completedState,
    });
    expect(mockSendToAllWindows).toHaveBeenCalledWith(
      PIPELINE_CHANNELS.EXECUTION_EVENT,
      expect.objectContaining({
        executionId: completedState.id,
        type: 'execution.updated',
        state: completedState,
      }),
    );
    expect(mockSyncPipelineExecutionState).toHaveBeenCalledWith(completedState);
    expect(mockHandlePipelineTerminalEvent).toHaveBeenCalledWith(
      expect.objectContaining({
        executionId: completedState.id,
        state: completedState,
      }),
    );
  });

  it('emits execution.updated for non-active cancel requests that already failed', async () => {
    const failedState = createState({
      id: 'exec-failed',
      status: 'failure',
    });
    mockCancelPipelineExecution.mockResolvedValueOnce(failedState);

    const handler = registeredHandlers.get(PIPELINE_CHANNELS.CANCEL_EXECUTION);
    const result = await handler?.({}, failedState.id);

    expect(mockCancelPipelineExecution).toHaveBeenCalledWith(
      failedState.id,
      runtime,
    );
    expect(result).toEqual({
      success: true,
      data: failedState,
    });
    expect(mockSendToAllWindows).toHaveBeenCalledWith(
      PIPELINE_CHANNELS.EXECUTION_EVENT,
      expect.objectContaining({
        executionId: failedState.id,
        type: 'execution.updated',
        state: failedState,
      }),
    );
    expect(mockSyncPipelineExecutionState).toHaveBeenCalledWith(failedState);
    expect(mockHandlePipelineTerminalEvent).toHaveBeenCalledWith(
      expect.objectContaining({
        executionId: failedState.id,
        state: failedState,
      }),
    );
  });

  it('does not notify watcher service for non-triggering pipeline events', async () => {
    const runningState = createState({
      id: 'exec-running',
      status: 'running',
    });
    mockExecutePipeline.mockResolvedValue(createHandle(runningState));

    const handler = registeredHandlers.get(PIPELINE_CHANNELS.EXECUTE);
    await handler?.(
      {},
      { name: 'test', on: 'dispatch', jobs: {} },
      {
        cwd: '/workspace/repo',
        pipelineId: 'test',
      },
    );
    const onEvent = mockExecutePipeline.mock.calls[0]?.[1]?.onEvent;
    if (!onEvent) {
      throw new Error('Expected pipeline onEvent handler');
    }

    onEvent({
      executionId: runningState.id,
      type: 'execution.updated',
      timestamp: runningState.started_at,
      state: runningState,
    });

    expect(mockSyncPipelineExecutionState).toHaveBeenCalledWith(runningState);
    expect(mockHandlePipelineTerminalEvent).not.toHaveBeenCalled();
  });

  it('notifies watcher service for paused pipeline events', async () => {
    const pausedState = createState({
      id: 'exec-paused',
      status: 'paused',
    });
    mockExecutePipeline.mockResolvedValue(createHandle(pausedState));

    const handler = registeredHandlers.get(PIPELINE_CHANNELS.EXECUTE);
    await handler?.(
      {},
      { name: 'test', on: 'dispatch', jobs: {} },
      {
        cwd: '/workspace/repo',
        pipelineId: 'test',
      },
    );
    const onEvent = mockExecutePipeline.mock.calls[0]?.[1]?.onEvent;
    if (!onEvent) {
      throw new Error('Expected pipeline onEvent handler');
    }

    onEvent({
      executionId: pausedState.id,
      type: 'execution.paused',
      timestamp: pausedState.started_at,
      state: pausedState,
    });

    expect(mockSyncPipelineExecutionState).toHaveBeenCalledWith(pausedState);
    expect(mockHandlePipelineTerminalEvent).toHaveBeenCalledWith(
      expect.objectContaining({
        executionId: pausedState.id,
        state: pausedState,
      }),
    );
  });

  it('does not notify watcher service for generic paused updates', async () => {
    const pausedState = createState({
      id: 'exec-paused-update',
      status: 'paused',
    });
    mockExecutePipeline.mockResolvedValue(createHandle(pausedState));

    const handler = registeredHandlers.get(PIPELINE_CHANNELS.EXECUTE);
    await handler?.(
      {},
      { name: 'test', on: 'dispatch', jobs: {} },
      {
        cwd: '/workspace/repo',
        pipelineId: 'test',
      },
    );
    const onEvent = mockExecutePipeline.mock.calls[0]?.[1]?.onEvent;
    if (!onEvent) {
      throw new Error('Expected pipeline onEvent handler');
    }

    onEvent({
      executionId: pausedState.id,
      type: 'execution.updated',
      timestamp: pausedState.started_at,
      state: pausedState,
    });

    expect(mockSyncPipelineExecutionState).toHaveBeenCalledWith(pausedState);
    expect(mockHandlePipelineTerminalEvent).not.toHaveBeenCalled();
  });

  it('records pipeline start and terminal usage events from lifecycle events', async () => {
    const startedState = createState({
      id: 'exec-start',
      status: 'running',
      project_id: 'workspace-1',
      worktree_id: 'worktree-1',
      event_name: 'plan_ready',
      pipeline_snapshot: {
        name: 'Pipeline 1',
        scope: ['directory'],
        jobs: {
          build: {
            name: 'Build',
            needs: [],
            timeout_minutes: 360,
            max_retries: 0,
            continue_on_error: false,
            steps: [
              {
                id: 'agent',
                uses: 'builtin/agent-prompt',
                shell: 'bash',
                continue_on_error: false,
                timeout_minutes: 360,
                skip_on_missing_action: false,
              },
              {
                id: 'hinted',
                uses: 'project/custom-agent',
                log_format_hint: 'agent',
                shell: 'bash',
                continue_on_error: false,
                timeout_minutes: 360,
                skip_on_missing_action: false,
              },
              {
                id: 'shell',
                run: 'echo ok',
                shell: 'bash',
                continue_on_error: false,
                timeout_minutes: 360,
                skip_on_missing_action: false,
              },
            ],
          },
        },
      },
      jobs: {
        build: {
          status: 'running',
          outputs: {},
          retry_count: 2,
          steps: {
            agent: {
              status: 'pending',
              outputs: {},
              dynamic_env: {},
            },
            hinted: {
              status: 'pending',
              outputs: {},
              dynamic_env: {},
            },
            shell: {
              status: 'pending',
              outputs: {},
              dynamic_env: {},
            },
          },
        },
      },
    });
    await emitPipelineLifecycleEvent(startedState, 'execution.started');

    expect(mockRecordUsageMetricEvent).toHaveBeenLastCalledWith(
      expect.objectContaining({
        id: 'pipeline-run-started:exec-start',
        type: 'pipeline_run_started',
        timestamp: startedState.started_at,
        workspaceId: 'workspace-1',
        worktreeId: 'worktree-1',
        provider: 'pipeline',
        initiationSource: 'user',
        pipelineExecutionId: 'exec-start',
        pipelineId: startedState.pipeline_id,
        pipelineName: startedState.pipeline_snapshot.name,
        pipelineIdentityKey: `inline:${startedState.pipeline_id}`,
        status: 'running',
        jobCount: 1,
        stepCount: 3,
        retryCount: 2,
      }),
    );
    const usageCalls = mockRecordUsageMetricEvent.mock.calls;
    const lastUsageEvent = usageCalls[usageCalls.length - 1]?.[0];
    expect(lastUsageEvent).not.toHaveProperty('repoId');
    // Agent steps are counted only once they have started, so a `started`
    // payload could only ever report 0. Emitting that 0 let a replayed RUNNING
    // payload arriving after the terminal event overwrite a completed run's
    // real count with zero, so the field is omitted entirely on start and the
    // terminal event is its only writer.
    expect(lastUsageEvent).not.toHaveProperty('agentStepCount');

    const completedState = createState({
      id: 'exec-completed',
      status: 'success',
      project_id: 'workspace-1',
      worktree_id: 'worktree-1',
      started_at: '2026-05-26T12:00:00.000Z',
      completed_at: '2026-05-26T12:05:00.000Z',
    });
    await emitPipelineLifecycleEvent(completedState, 'execution.completed');

    expect(mockRecordUsageMetricEvent).toHaveBeenLastCalledWith(
      expect.objectContaining({
        id: 'pipeline-run-completed:exec-completed',
        type: 'pipeline_run_completed',
        timestamp: completedState.completed_at,
        runStartedAt: completedState.started_at,
        runCompletedAt: completedState.completed_at,
        runDurationMs: 300_000,
        status: 'success',
      }),
    );
  });

  it('records zero agent steps for a completed all-pending execution shape', async () => {
    const pendingState = createState({
      id: 'exec-completed-pending',
      status: 'success',
      project_id: 'workspace-1',
      worktree_id: 'worktree-1',
      completed_at: '2026-05-26T12:05:00.000Z',
      pipeline_snapshot: {
        name: 'Pipeline 1',
        scope: ['directory'],
        jobs: {
          build: {
            name: 'Build',
            needs: [],
            timeout_minutes: 360,
            max_retries: 0,
            continue_on_error: false,
            steps: [
              {
                id: 'agent',
                uses: 'builtin/agent-prompt',
                shell: 'bash',
                continue_on_error: false,
                timeout_minutes: 360,
                skip_on_missing_action: false,
              },
            ],
          },
        },
      },
      jobs: {
        build: {
          status: 'success',
          outputs: {},
          steps: {
            agent: {
              status: 'pending',
              outputs: {},
              dynamic_env: {},
            },
          },
        },
      },
      job_definitions: {
        build: {
          name: 'Build',
          needs: [],
          timeout_minutes: 360,
          max_retries: 0,
          continue_on_error: false,
          physical_job_id: 'build',
          logical_job_id: 'build',
          steps: [
            {
              id: 'agent',
              uses: 'builtin/agent-prompt',
              shell: 'bash',
              continue_on_error: false,
              timeout_minutes: 360,
              skip_on_missing_action: false,
            },
          ],
        },
      },
    });

    await emitPipelineLifecycleEvent(pendingState, 'execution.completed');

    expect(mockRecordUsageMetricEvent).toHaveBeenLastCalledWith(
      expect.objectContaining({
        id: 'pipeline-run-completed:exec-completed-pending',
        agentStepCount: 0,
      }),
    );
  });

  it('keeps bundled agent action fast-path refs aligned with manifests', () => {
    const bundledAgentActionRefs = listBundledAgentActionRefsFromResources();
    const fastPathRefs = listBundledAgentActionRefsFromUsageRecorderFastPath();

    expect(bundledAgentActionRefs).not.toHaveLength(0);
    expect(fastPathRefs).toEqual(bundledAgentActionRefs);
  });

  it('records explicit pipeline initiation sources without inferring from event names', async () => {
    await emitPipelineLifecycleEvent(
      createState({
        id: 'exec-app-advisor',
        status: 'running',
        project_id: 'workspace-1',
        worktree_id: 'worktree-1',
        event_name: 'task_ready',
        initiation_source: 'app_advisor',
      }),
      'execution.started',
    );

    expect(mockRecordUsageMetricEvent).toHaveBeenLastCalledWith(
      expect.objectContaining({
        id: 'pipeline-run-started:exec-app-advisor',
        initiationSource: 'app_advisor',
        eventName: 'task_ready',
      }),
    );

    await emitPipelineLifecycleEvent(
      createState({
        id: 'exec-hook',
        status: 'running',
        project_id: 'workspace-1',
        worktree_id: 'worktree-1',
        initiation_source: 'app_advisor',
        trigger_source: {
          kind: 'hook',
          hook_key: 'hook-1',
          hook_label: 'Hook 1',
          trigger_name: 'pr:create',
          target: 'workspace-root',
          action_index: 0,
          triggered_at: '2026-05-26T12:00:00.000Z',
        },
      }),
      'execution.started',
    );

    expect(mockRecordUsageMetricEvent).toHaveBeenLastCalledWith(
      expect.objectContaining({
        id: 'pipeline-run-started:exec-hook',
        initiationSource: 'hook',
        triggerSource: 'hook',
      }),
    );
  });

  it.each([
    [
      'stored bundled',
      {
        pipeline_preference_locator: {
          type: 'stored' as const,
          source: 'bundled' as const,
          value: 'review',
        },
      },
      'stored:bundled:review',
      'bundled',
    ],
    [
      'stored user',
      {
        pipeline_preference_locator: {
          type: 'stored' as const,
          source: 'user' as const,
          value: 'deploy',
        },
      },
      'stored:user:deploy',
      'user',
    ],
    [
      'file',
      {
        pipeline_preference_locator: {
          type: 'file' as const,
          value: '/workspace/repo/.canopy/pipelines/deploy.yaml',
        },
      },
      'file:/workspace/repo/.canopy/pipelines/deploy.yaml',
      'project',
    ],
    [
      'shared locator',
      {
        pipeline_preference_locator: {
          type: 'shared' as const,
          value: 'server-1:remote-1',
        },
      },
      'shared:server-1:remote-1',
      'shared',
    ],
    [
      'shared source fallback',
      {
        shared_pipeline_source: {
          type: 'shared' as const,
          serverId: 'server-2',
          serverName: 'Server 2',
          remoteId: 'remote-2',
          cachedPipelinePath: '/tmp/pipeline.yaml',
          fetchedAt: '2026-05-26T12:00:00.000Z',
        },
      },
      'shared:server-2:remote-2',
      'shared',
    ],
    ['inline fallback', {}, 'inline:pipeline-1', 'inline'],
  ])(
    'records %s pipeline identity fields',
    async (
      _label,
      overrides: Partial<ExecutionState>,
      expectedKey: string,
      expectedSource: string,
    ) => {
      const state = createState({
        project_id: 'workspace-1',
        worktree_id: 'worktree-1',
        ...overrides,
      });

      await emitPipelineLifecycleEvent(state, 'execution.started');

      expect(mockRecordUsageMetricEvent).toHaveBeenLastCalledWith(
        expect.objectContaining({
          pipeline: {
            id: state.pipeline_id,
            name: state.pipeline_snapshot.name,
            key: expectedKey,
            source: expectedSource,
          },
          pipelineId: state.pipeline_id,
          pipelineName: state.pipeline_snapshot.name,
          pipelineIdentityKey: expectedKey,
        }),
      );
    },
  );

  it('reuses deterministic usage ids for retries and records distinct rerun ids', async () => {
    const retryState = createState({
      id: 'exec-retry',
      status: 'running',
      project_id: 'workspace-1',
      worktree_id: 'worktree-1',
    });

    await emitPipelineLifecycleEvent(retryState, 'execution.started');
    await emitPipelineLifecycleEvent(retryState, 'execution.started');

    expect(
      mockRecordUsageMetricEvent.mock.calls
        .map((call) => call[0]?.id)
        .filter((id) => id === 'pipeline-run-started:exec-retry'),
    ).toHaveLength(2);

    const rerunState = createState({
      id: 'exec-rerun',
      status: 'success',
      project_id: 'workspace-1',
      worktree_id: 'worktree-1',
      rerun_source_id: retryState.id,
      completed_at: '2026-05-26T12:05:00.000Z',
    });

    await emitPipelineLifecycleEvent(rerunState, 'execution.completed');

    expect(mockRecordUsageMetricEvent).toHaveBeenLastCalledWith(
      expect.objectContaining({
        id: 'pipeline-run-completed:exec-rerun',
        rerunSourceId: retryState.id,
      }),
    );
  });

  it('records parent execution ids and drops non-terminal statuses on terminal lifecycle events', async () => {
    const state = createState({
      id: 'exec-child',
      status: 'paused',
      project_id: 'workspace-1',
      worktree_id: 'worktree-1',
      parent_execution_id: 'exec-parent',
      completed_at: '2026-05-26T12:05:00.000Z',
    });

    await emitPipelineLifecycleEvent(state, 'execution.completed');

    expect(mockRecordUsageMetricEvent).toHaveBeenLastCalledWith(
      expect.objectContaining({
        id: 'pipeline-run-completed:exec-child',
        parentExecutionId: 'exec-parent',
        status: undefined,
      }),
    );
  });

  it('skips pipeline usage recording for hidden executions and executions without a project', async () => {
    await emitPipelineLifecycleEvent(
      createState({
        id: 'exec-hidden',
        project_id: 'workspace-1',
        worktree_id: 'worktree-1',
        hidden: true,
      }),
      'execution.started',
    );
    await emitPipelineLifecycleEvent(
      createState({
        id: 'exec-no-workspace',
      }),
      'execution.started',
    );

    expect(mockRecordUsageMetricEvent).not.toHaveBeenCalled();
  });

  it('rebuilds base-branch env on resume', async () => {
    const reasonId = '123e4567-e89b-42d3-a456-426614174000';
    const sourceState = createState({
      project_id: 'project-1',
      worktree_id: 'wt-1',
    });

    mockLoadExecutionState.mockResolvedValue(sourceState);
    mockReadPreferencesFile.mockResolvedValue(
      makePipelinePreferences({
        rtkEnabled: true,
        codexMultiAgentPipelinesEnabled: true,
      }),
    );
    mockResolveLinearToken.mockResolvedValue(null);
    mockBuildPipelineBaseBranchEnv.mockResolvedValue({
      CANOPY_BASE_BRANCH: 'release/1.2',
      CANOPY_BASE_BRANCH_EXISTS_IN_REMOTE: 'false',
    });
    mockResumePipeline.mockResolvedValue(createHandle(sourceState));

    const handler = registeredHandlers.get(PIPELINE_CHANNELS.RESUME);
    const result = await handler?.({}, sourceState.id, {
      cwd: '/workspace/repo',
      env: { USER_ENV: '1' },
      inputs: { target: 'production' },
      repoPath: '/workspace/repo/packages/api',
      statusReasonIds: [reasonId],
    });

    expect(mockBuildPipelineBaseBranchEnv).toHaveBeenCalledWith({
      cwd: '/workspace/repo',
      projectId: 'project-1',
      worktreeId: 'wt-1',
    });
    const resumeCall = mockResumePipeline.mock.calls[0];
    expect(resumeCall?.[0]).toBe(sourceState.id);
    expect(resumeCall?.[1]?.cwd).toBe('/workspace/repo');
    expect(resumeCall?.[1]?.statusReasonIds).toEqual([reasonId]);
    expect(resumeCall?.[1]?.inputs).toEqual({ target: 'production' });
    expect(resumeCall?.[1]?.repoPath).toBe('/workspace/repo/packages/api');
    expect(resumeCall?.[1]?.env).toMatchObject({
      CANOPY_BASE_BRANCH: 'release/1.2',
      CANOPY_BASE_BRANCH_EXISTS_IN_REMOTE: 'false',
      CANOPY_PREF_RTK_ENABLED: 'true',
      CANOPY_PREF_CODEX_MULTI_AGENT_PIPELINES_ENABLED: 'true',
      USER_ENV: '1',
    });
    expect(result).toEqual({
      success: true,
      data: sourceState,
    });
    expectLastAdvisorWatchExecution(sourceState.id);

    resumeCall?.[1]?.onEvent?.({
      executionId: sourceState.id,
      type: 'execution.started',
      timestamp: sourceState.started_at,
      state: sourceState,
    });
    expect(mockRecordUsageMetricEvent).toHaveBeenLastCalledWith(
      expect.objectContaining({
        id: `pipeline-run-started:${sourceState.id}`,
        type: 'pipeline_run_started',
      }),
    );
  });

  it('rejects resume requests with invalid execution ids before loading state', async () => {
    const handler = registeredHandlers.get(PIPELINE_CHANNELS.RESUME);

    await expect(
      handler?.({}, '../outside', { statusReasonIds: [] }),
    ).resolves.toEqual({
      success: false,
      error: 'Invalid executionId: must be lowercase alphanumeric with hyphens',
    });
    expect(mockLoadExecutionState).not.toHaveBeenCalled();
    expect(mockResumePipeline).not.toHaveBeenCalled();
  });

  it('attributes App Advisor resumes to automation', async () => {
    const sourceState = createState({ status: 'paused' });
    mockLoadExecutionState.mockResolvedValue(sourceState);
    mockReadPreferencesFile.mockResolvedValue(makePipelinePreferences());
    mockResolveLinearToken.mockResolvedValue(null);
    mockBuildPipelineBaseBranchEnv.mockResolvedValue({});
    mockResumePipeline.mockResolvedValue(createHandle(sourceState));

    const handler = registeredHandlers.get(PIPELINE_CHANNELS.RESUME_AUTOMATION);
    await handler?.({}, sourceState.id, {});

    expect(mockResumePipeline).toHaveBeenCalledWith(
      sourceState.id,
      expect.objectContaining({
        initiationSource: 'automation',
      }),
    );
  });

  it('retries from stored execution metadata, re-resolves Linear auth, and forwards live events', async () => {
    const resolvedCwd = path.join(tempDir, 'resolved-worktree');
    fs.mkdirSync(resolvedCwd, { recursive: true });

    const sourceState = createState({
      status: 'failure',
      project_id: 'project-1',
      worktree_id: 'wt-1',
      repo_path: '/repo/path',
      env: {
        FOO: 'bar',
        CANOPY_BASE_BRANCH: 'stale-base',
        CANOPY_BASE_BRANCH_EXISTS_IN_REMOTE: 'false',
        CANOPY_BASE_BRANCH_BY_REPO: '{"repo":"stale-base"}',
        CANOPY_BASE_BRANCH_EXISTS_IN_REMOTE_BY_REPO: '{"repo":"false"}',
        CANOPY_PREF_CODEX_MULTI_AGENT_PIPELINES_ENABLED: 'true',
        CANOPY_PREF_CODEX_MAX_CONCURRENT_SUBAGENTS: '5',
        CANOPY_OUTPUT_DIR: '/stale/output',
      },
    });
    const retryState: ExecutionState = {
      ...sourceState,
      status: 'running',
    };

    mockLoadExecutionState.mockResolvedValue(sourceState);
    mockReadPreferencesFile.mockResolvedValue(
      makePipelinePreferences({ codexMultiAgentPipelinesEnabled: false }),
    );
    mockResolveLinearToken.mockResolvedValue('linear-token');
    mockResolveWorktreeCwd.mockReturnValue(resolvedCwd);
    mockRetryPipelineExecution.mockImplementation(
      (
        _executionId: string,
        options: {
          onEvent?: (event: ExecutionEvent) => void;
          onStepOutput?: (event: StepOutputEvent) => void;
        },
      ): Promise<ExecutionHandle> => {
        options.onEvent?.({
          executionId: retryState.id,
          type: 'execution.started',
          state: retryState,
          timestamp: new Date().toISOString(),
        });
        options.onStepOutput?.({
          executionId: retryState.id,
          jobId: 'build',
          jobName: 'Build',
          stepId: 'step-1',
          stepName: 'Step 1',
          attempt: 1,
          stream: 'stdout',
          data: 'hello',
        });
        return Promise.resolve(createHandle(retryState));
      },
    );

    const handler = registeredHandlers.get(PIPELINE_CHANNELS.RETRY_EXECUTION);
    const result = await handler?.({}, sourceState.id);

    expect(mockResolveLinearToken).toHaveBeenCalledTimes(1);
    const retryCall = mockRetryPipelineExecution.mock.calls[0];
    expect(retryCall).toBeDefined();
    if (!retryCall) {
      throw new Error('Expected retryPipelineExecution to be called');
    }
    const [, retryOptions] = retryCall;
    expect(retryOptions.cwd).toBe(resolvedCwd);
    expect(retryOptions.env).toEqual({
      CANOPY_PREF_RTK_ENABLED: 'true',
      CANOPY_PREF_CODEX_MULTI_AGENT_PIPELINES_ENABLED: 'false',
      CANOPY_PREF_CODEX_MAX_CONCURRENT_SUBAGENTS: 'default',
      CANOPY_PREF_LOCAL_MEMORY_ENABLED: '1',
      CANOPY_PREF_PR_GENERATION_MODEL: 'claude-sonnet-4-6',
      CANOPY_PREF_PR_GENERATION_THINKING_LEVEL: 'high',
      CANOPY_PREF_PR_INSTRUCTIONS: '',
      CANOPY_PREF_PR_INSTRUCTION_MODE: 'append',
      CANOPY_PREF_COMMIT_GENERATION_MODEL: 'claude-sonnet-4-6',
      CANOPY_PREF_COMMIT_GENERATION_THINKING_LEVEL: 'high',
      CANOPY_PREF_COMMIT_INSTRUCTIONS: '',
      CANOPY_PREF_COMMIT_INSTRUCTION_MODE: 'append',
      CANOPY_BASE_BRANCH: 'develop',
      CANOPY_BASE_BRANCH_EXISTS_IN_REMOTE: 'true',
    });
    expect(retryOptions.repoPath).toBe('/repo/path');
    expect(retryOptions.secretEnv).toEqual({
      CANOPY_LINEAR_API_KEY: 'linear-token',
    });
    expect(retryOptions.runtime).toBe(runtime);
    expect(retryOptions.onEvent).toEqual(expect.any(Function));
    expect(retryOptions.onStepOutput).toEqual(expect.any(Function));
    expect(result).toEqual({
      success: true,
      data: retryState,
    });
    expect(mockSendToAllWindows).toHaveBeenCalledWith(
      PIPELINE_CHANNELS.EXECUTION_EVENT,
      expect.objectContaining({
        executionId: retryState.id,
        type: 'execution.started',
      }),
    );
    expect(mockSendToAllWindows).toHaveBeenCalledWith(
      PIPELINE_CHANNELS.STEP_OUTPUT_EVENT,
      expect.objectContaining({
        executionId: retryState.id,
        stepId: 'step-1',
      }),
    );
    expect(mockSyncPipelineExecutionState).toHaveBeenCalledWith(retryState);
    expect(mockObservePipelineOutput).toHaveBeenCalledWith(
      expect.objectContaining({
        executionId: retryState.id,
        stepId: 'step-1',
      }),
    );
    expectLastAdvisorWatchExecution(sourceState.id);
    expect(mockWithWorkspaceTargetRuntimeStartReservation).toHaveBeenCalledWith(
      'project-1',
      'wt-1',
      expect.any(Function),
    );
  });

  it.each(['rerun', 'retry'])(
    'derives foreground organization context for %s and refuses a missing destination',
    async (mode): Promise<void> => {
      mockBackgroundEnabled.mockReturnValue(true);
      const context = 'org:aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa';
      const source = createState({
        project_id: 'project-1',
        worktree_id: 'wt-1',
      });
      delete source.execution_context;
      mockLoadExecutionState.mockResolvedValue(source);
      mockRerunPipelineExecution.mockResolvedValue(createHandle(source));
      mockRetryPipelineExecution.mockResolvedValue(createHandle(source));
      mockAuthorizeBackground.mockImplementation(
        (
          binding,
          _resources,
          target,
        ): ReturnType<typeof authorizeBackgroundExecution> =>
          Promise.resolve(
            binding === context &&
              target !== undefined &&
              'projectId' in target &&
              target.projectId
              ? { allow: true }
              : { allow: false, reason: 'context-mismatch' },
          ),
      );
      const handler = registeredHandlers.get(
        mode === 'rerun'
          ? PIPELINE_CHANNELS.RERUN_EXECUTION
          : PIPELINE_CHANNELS.RETRY_EXECUTION,
      );
      expect(await handler?.({}, source.id)).toMatchObject({ success: true });
      expect(mockAuthorizeBackground).toHaveBeenCalledWith(
        context,
        expect.any(Array),
        { projectId: 'project-1', worktreeId: 'wt-1' },
        [],
      );
      const options =
        mode === 'rerun'
          ? mockRerunPipelineExecution.mock.calls[0]?.[1]
          : mockRetryPipelineExecution.mock.calls[0]?.[1];
      expect(options?.executionContext).toBe(context);
      delete source.project_id;
      delete source.worktree_id;
      expect(await handler?.({}, source.id)).toMatchObject({ success: false });
    },
  );

  it.each(['rerun', 'retry'])(
    'reauthorizes persisted %s executions and replaces cached child permissions',
    async (mode): Promise<void> => {
      mockBackgroundEnabled.mockReturnValue(true);
      const source = createState({
        execution_context: 'org:aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa',
        project_id: 'project-1',
        worktree_id: 'wt-1',
        child_pipeline_authorizations: [],
      });
      mockLoadExecutionState.mockResolvedValue(source);
      mockRerunPipelineExecution.mockResolvedValue(createHandle(source));
      mockRetryPipelineExecution.mockResolvedValue(createHandle(source));
      mockAuthorizeBackground.mockResolvedValue({
        allow: false,
        reason: 'access-removed',
      });
      const handler = registeredHandlers.get(
        mode === 'rerun'
          ? PIPELINE_CHANNELS.RERUN_EXECUTION
          : PIPELINE_CHANNELS.RETRY_EXECUTION,
      );
      expect(await handler?.({}, source.id)).toEqual({
        success: false,
        error: backgroundExecutionDeniedMessage('access-removed'),
      });
      expect(mockRerunPipelineExecution).not.toHaveBeenCalled();
      expect(mockRetryPipelineExecution).not.toHaveBeenCalled();
      expect(mockAuthorizeBackground).toHaveBeenCalledWith(
        source.execution_context,
        expect.any(Array),
        { projectId: 'project-1', worktreeId: 'wt-1' },
        [],
      );
      source.execution_context = 'personal';
      const record = {
        request: 'child',
        identity: 'local',
        contentHash: 'a'.repeat(64),
      };
      mockAuthorizeBackground.mockImplementation(
        (_context, _resources, _destination, records) => {
          records?.push(record);
          return Promise.resolve({ allow: true });
        },
      );
      expect(await handler?.({}, source.id)).toMatchObject({ success: true });
      const options =
        mode === 'rerun'
          ? mockRerunPipelineExecution.mock.calls[0]?.[1]
          : mockRetryPipelineExecution.mock.calls[0]?.[1];
      expect(options?.childPipelineAuthorizations).toEqual([record]);
      expect(options?.childPipelineAuthorizations).not.toBe(
        source.child_pipeline_authorizations,
      );
      expect(options).not.toHaveProperty('allowUnverifiedForegroundChildren');
    },
  );

  it('falls back to the stored cwd when worktree resolution is unavailable', async () => {
    const sourceState = createState({
      repo_path: '/repo/path',
      project_id: 'project-1',
      worktree_id: 'wt-1',
      env: {
        FOO: 'bar',
        CANOPY_BASE_BRANCH: 'stale-base',
        CANOPY_BASE_BRANCH_EXISTS_IN_REMOTE: 'false',
        CANOPY_BASE_BRANCH_BY_REPO: '{"repo":"stale-base"}',
        CANOPY_BASE_BRANCH_EXISTS_IN_REMOTE_BY_REPO: '{"repo":"false"}',
        CANOPY_PREF_CODEX_MULTI_AGENT_PIPELINES_ENABLED: 'false',
        CANOPY_OUTPUT_DIR: '/stale/output',
      },
    });

    mockLoadExecutionState.mockResolvedValue(sourceState);
    mockReadPreferencesFile.mockResolvedValue(
      makePipelinePreferences({
        codexMultiAgentPipelinesEnabled: true,
        localMemoryEnabled: false,
      }),
    );
    mockResolveLinearToken.mockResolvedValue(null);
    mockResolveWorktreeCwd.mockReturnValue(
      path.join(tempDir, 'missing-worktree'),
    );
    mockRerunPipelineExecution.mockResolvedValue(createHandle(sourceState));

    const handler = registeredHandlers.get(PIPELINE_CHANNELS.RERUN_EXECUTION);
    const result = await handler?.({}, sourceState.id);

    const rerunCall = mockRerunPipelineExecution.mock.calls[0];
    expect(rerunCall).toBeDefined();
    if (!rerunCall) {
      throw new Error('Expected rerunPipelineExecution to be called');
    }
    const [, rerunOptions] = rerunCall;
    expect(rerunOptions.cwd).toBe(sourceState.cwd);
    expect(mockAuthorizeBackground).not.toHaveBeenCalled();
    expect(rerunOptions).not.toHaveProperty('childPipelineAuthorizations');
    expect(rerunOptions.env).toEqual({
      CANOPY_PREF_RTK_ENABLED: 'true',
      CANOPY_PREF_CODEX_MULTI_AGENT_PIPELINES_ENABLED: 'true',
      CANOPY_PREF_CODEX_MAX_CONCURRENT_SUBAGENTS: 'default',
      CANOPY_PREF_LOCAL_MEMORY_ENABLED: '0',
      CANOPY_PREF_PR_GENERATION_MODEL: 'claude-sonnet-4-6',
      CANOPY_PREF_PR_GENERATION_THINKING_LEVEL: 'high',
      CANOPY_PREF_PR_INSTRUCTIONS: '',
      CANOPY_PREF_PR_INSTRUCTION_MODE: 'append',
      CANOPY_PREF_COMMIT_GENERATION_MODEL: 'claude-sonnet-4-6',
      CANOPY_PREF_COMMIT_GENERATION_THINKING_LEVEL: 'high',
      CANOPY_PREF_COMMIT_INSTRUCTIONS: '',
      CANOPY_PREF_COMMIT_INSTRUCTION_MODE: 'append',
      CANOPY_BASE_BRANCH: 'develop',
      CANOPY_BASE_BRANCH_EXISTS_IN_REMOTE: 'true',
    });
    expect(rerunOptions.repoPath).toBe('/repo/path');
    expect(rerunOptions.secretEnv).toBeUndefined();
    expect(rerunOptions.runtime).toBe(runtime);
    expect(rerunOptions.onEvent).toEqual(expect.any(Function));
    expect(rerunOptions.onStepOutput).toEqual(expect.any(Function));
    expect(result).toEqual({
      success: true,
      data: sourceState,
    });
    expectLastAdvisorWatchExecution(sourceState.id);
    expect(mockWithWorkspaceTargetRuntimeStartReservation).toHaveBeenCalledWith(
      'project-1',
      'wt-1',
      expect.any(Function),
    );
  });

  it('reruns the exact persisted shared YAML and package snapshot', async () => {
    const sourceState = createState({
      repo_path: '/repo/path',
      pipeline_package_snapshot: {
        digest: `pp:v1:${'A'.repeat(43)}`,
        pipelineContentHash: 'a'.repeat(64),
        cachedPackagePath: path.join(tempDir, 'persisted-package'),
        bindings: [],
        capturedAt: '2026-04-26T12:00:00.000Z',
      },
      shared_pipeline_source: {
        type: 'shared',
        serverId: 'canopy-cloud',
        serverName: 'Canopy Cloud',
        remoteId: 'remote-rerun',
        cachedPipelinePath: path.join(tempDir, 'old-shared-pipeline.yaml'),
        fetchedAt: '2026-04-26T12:00:00.000Z',
      },
    });
    mockLoadExecutionState.mockResolvedValue(sourceState);
    mockResolveLinearToken.mockResolvedValue(null);
    mockResolveWorktreeCwd.mockReturnValue(
      path.join(tempDir, 'missing-worktree'),
    );
    mockRerunPipelineExecution.mockResolvedValue(createHandle(sourceState));

    const handler = registeredHandlers.get(PIPELINE_CHANNELS.RERUN_EXECUTION);
    const result = await handler?.({}, sourceState.id);

    const rerunCall = mockRerunPipelineExecution.mock.calls[0];
    expect(rerunCall).toBeDefined();
    if (!rerunCall) {
      throw new Error('Expected rerunPipelineExecution to be called');
    }
    const [, rerunOptions] = rerunCall;
    expect(rerunOptions.pipelineOverride).toBeUndefined();
    expect(rerunOptions.pipelinePackage).toBeUndefined();
    expect(rerunOptions.sharedPipelineSource).toBeUndefined();
    expect(rerunOptions.executionId).not.toBe(sourceState.id);
    expect(mockedGetSharedPipeline).not.toHaveBeenCalled();
    expect(result).toEqual({
      success: true,
      data: sourceState,
    });
  });

  it('forwards an explicit portal initiation source to rerun execution', async () => {
    const sourceState = createState({
      repo_path: '/repo/path',
      initiation_source: 'automation',
    });
    mockLoadExecutionState.mockResolvedValue(sourceState);
    mockResolveLinearToken.mockResolvedValue(null);
    mockResolveWorktreeCwd.mockReturnValue(
      path.join(tempDir, 'missing-worktree'),
    );
    mockRerunPipelineExecution.mockResolvedValue(createHandle(sourceState));

    await rerunPipelineExecutionFromMain({
      executionId: sourceState.id,
      initiationSource: 'portal',
      getWindow: () => null,
    });

    expect(mockRerunPipelineExecution.mock.calls[0]?.[1]).toMatchObject({
      initiationSource: 'portal',
    });
  });

  it('reserves retry executions before async setup to prevent duplicate starts', async () => {
    const sourceState = createState({
      status: 'failure',
    });
    const retryLoad = createDeferred<ExecutionState>();

    mockLoadExecutionState.mockReturnValue(retryLoad.promise);
    mockResolveLinearToken.mockResolvedValue(null);
    mockRetryPipelineExecution.mockResolvedValue(createHandle(sourceState));

    const handler = registeredHandlers.get(PIPELINE_CHANNELS.RETRY_EXECUTION);
    expect(handler).toBeDefined();
    if (!handler) {
      throw new Error('Retry execution handler was not registered');
    }

    const firstAttempt = Promise.resolve(handler({}, sourceState.id));
    const secondAttempt = await handler({}, sourceState.id);

    expect(secondAttempt).toEqual({
      success: false,
      error: `Execution "${sourceState.id}" is already running`,
    });

    retryLoad.resolve(sourceState);
    await expect(firstAttempt).resolves.toEqual({
      success: true,
      data: sourceState,
    });
  });

  it('releases retry reservations when startup fails', async () => {
    const sourceState = createState({
      status: 'failure',
    });

    mockLoadExecutionState.mockRejectedValueOnce(new Error('load failed'));
    mockLoadExecutionState.mockResolvedValueOnce(sourceState);
    mockResolveLinearToken.mockResolvedValue(null);
    mockRetryPipelineExecution.mockResolvedValue(createHandle(sourceState));

    const handler = registeredHandlers.get(PIPELINE_CHANNELS.RETRY_EXECUTION);
    expect(handler).toBeDefined();
    if (!handler) {
      throw new Error('Retry execution handler was not registered');
    }

    await expect(handler({}, sourceState.id)).resolves.toEqual({
      success: false,
      error: 'load failed',
    });
    await expect(handler({}, sourceState.id)).resolves.toEqual({
      success: true,
      data: sourceState,
    });
  });

  it('rejects retry requests with invalid execution ids before loading state', async () => {
    const handler = registeredHandlers.get(PIPELINE_CHANNELS.RETRY_EXECUTION);

    await expect(handler?.({}, 'Execution_1')).resolves.toEqual({
      success: false,
      error: 'Invalid executionId: must be lowercase alphanumeric with hyphens',
    });
    expect(mockLoadExecutionState).not.toHaveBeenCalled();
    expect(mockRetryPipelineExecution).not.toHaveBeenCalled();
  });

  it('prevents duplicate reruns from the same source execution while one is active', async () => {
    const sourceState = createState({
      status: 'success',
    });
    const rerunState = createState({
      id: 'rerun-1',
      rerun_source_id: sourceState.id,
    });

    let resolveCompletion!: (state: ExecutionState) => void;
    const completion = new Promise<ExecutionState>((resolve) => {
      resolveCompletion = resolve;
    });

    mockLoadExecutionState.mockResolvedValue(sourceState);
    mockResolveLinearToken.mockResolvedValue(null);
    mockRerunPipelineExecution.mockResolvedValue(
      createHandle(rerunState, completion),
    );

    const handler = registeredHandlers.get(PIPELINE_CHANNELS.RERUN_EXECUTION);
    const first = await handler?.({}, sourceState.id);
    const second = await handler?.({}, sourceState.id);

    expect(first).toEqual({
      success: true,
      data: rerunState,
    });
    expect(second).toEqual({
      success: false,
      error: `Execution "${sourceState.id}" is already being rerun`,
    });
    expect(mockWatchExecution).toHaveBeenCalledTimes(1);
    expectLastAdvisorWatchExecution(rerunState.id);

    resolveCompletion(rerunState);
    await completion;
    await Promise.resolve();

    const third = await handler?.({}, sourceState.id);
    expect(third).toEqual({
      success: true,
      data: rerunState,
    });
    expect(mockWatchExecution).toHaveBeenCalledTimes(2);
  });

  it('does not start advisor tracking until executePipeline returns a handle', async () => {
    const executionState = createState({ id: 'queued-start-1' });
    const executeDeferred = createDeferred<ExecutionHandle>();
    const executeStarted = createDeferred<void>();

    mockResolveLinearToken.mockResolvedValue(null);
    mockReadPreferencesFile.mockResolvedValue(makePipelinePreferences());
    mockExecutePipeline.mockImplementation(() => {
      executeStarted.resolve();
      return executeDeferred.promise;
    });

    const handler = registeredHandlers.get(PIPELINE_CHANNELS.EXECUTE);
    expect(handler).toBeDefined();
    if (!handler) {
      throw new Error('Execute handler was not registered');
    }

    const resultPromise = Promise.resolve(
      handler(
        {},
        { name: 'Queued Start', on: 'dispatch', jobs: {} },
        {
          cwd: '/workspace/repo',
          pipelineId: 'queued-start',
        },
      ),
    );

    await executeStarted.promise;
    expect(mockExecutePipeline).toHaveBeenCalledTimes(1);
    expect(mockWatchExecution).not.toHaveBeenCalled();

    executeDeferred.resolve(createHandle(executionState));
    await expect(resultPromise).resolves.toEqual({
      success: true,
      data: executionState,
    });
    expectLastAdvisorWatchExecution('queued-start-1');
  });

  it('rejects rerun requests with invalid execution ids before loading state', async () => {
    const handler = registeredHandlers.get(PIPELINE_CHANNELS.RERUN_EXECUTION);

    await expect(handler?.({}, 'Execution_1')).resolves.toEqual({
      success: false,
      error: 'Invalid executionId: must be lowercase alphanumeric with hyphens',
    });
    expect(mockLoadExecutionState).not.toHaveBeenCalled();
    expect(mockRerunPipelineExecution).not.toHaveBeenCalled();
  });

  describe('split-lock guard (retry/start-over bypass the guarded EXECUTE seam)', () => {
    const LOCK_WS = 'lock-ws';
    const LOCK_WT = 'lock-wt';
    const OTHER_WT = 'lock-wt-other';

    afterEach(() => {
      releaseSplitLock(LOCK_WS, LOCK_WT);
      releaseSplitLock(LOCK_WS, OTHER_WT);
    });

    it('refuses to retry a worktree-scoped execution when its worktree is split-locked', async () => {
      const sourceState = createState({
        status: 'failure',
        scope: 'worktree',
        project_id: LOCK_WS,
        worktree_id: LOCK_WT,
      });
      mockLoadExecutionState.mockResolvedValue(sourceState);

      acquireSplitLock(LOCK_WS, LOCK_WT);

      const handler = registeredHandlers.get(PIPELINE_CHANNELS.RETRY_EXECUTION);
      const result = await handler?.({}, sourceState.id);

      expect(result).toMatchObject({ success: false });
      expect(result).toHaveProperty(
        'error',
        expect.stringContaining('locked while a Split PR is in progress'),
      );
      expect(mockRetryPipelineExecution).not.toHaveBeenCalled();
    });

    it('allows retry when a DIFFERENT worktree is split-locked', async () => {
      const sourceState = createState({
        status: 'failure',
        scope: 'worktree',
        project_id: LOCK_WS,
        worktree_id: LOCK_WT,
      });
      mockLoadExecutionState.mockResolvedValue(sourceState);
      mockResolveLinearToken.mockResolvedValue(null);
      mockRetryPipelineExecution.mockResolvedValue(createHandle(sourceState));

      acquireSplitLock(LOCK_WS, OTHER_WT);

      const handler = registeredHandlers.get(PIPELINE_CHANNELS.RETRY_EXECUTION);
      const result = await handler?.({}, sourceState.id);

      expect(result).toEqual({ success: true, data: sourceState });
      expect(mockRetryPipelineExecution).toHaveBeenCalledTimes(1);
    });

    it('refuses to start over (rerun) a worktree-scoped execution when its worktree is split-locked', async () => {
      const sourceState = createState({
        status: 'success',
        scope: 'worktree',
        project_id: LOCK_WS,
        worktree_id: LOCK_WT,
      });
      mockLoadExecutionState.mockResolvedValue(sourceState);

      acquireSplitLock(LOCK_WS, LOCK_WT);

      const handler = registeredHandlers.get(PIPELINE_CHANNELS.RERUN_EXECUTION);
      const result = await handler?.({}, sourceState.id);

      expect(result).toMatchObject({ success: false });
      expect(result).toHaveProperty(
        'error',
        expect.stringContaining('locked while a Split PR is in progress'),
      );
      expect(mockRerunPipelineExecution).not.toHaveBeenCalled();
    });

    it('allows start-over (rerun) when a DIFFERENT worktree is split-locked', async () => {
      const sourceState = createState({
        status: 'success',
        scope: 'worktree',
        project_id: LOCK_WS,
        worktree_id: LOCK_WT,
      });
      mockLoadExecutionState.mockResolvedValue(sourceState);
      mockResolveLinearToken.mockResolvedValue(null);
      mockRerunPipelineExecution.mockResolvedValue(createHandle(sourceState));

      acquireSplitLock(LOCK_WS, OTHER_WT);

      const handler = registeredHandlers.get(PIPELINE_CHANNELS.RERUN_EXECUTION);
      const result = await handler?.({}, sourceState.id);

      expect(result).toEqual({ success: true, data: sourceState });
      expect(mockRerunPipelineExecution).toHaveBeenCalledTimes(1);
    });

    it('does not apply the guard to a non-worktree-scoped execution', async () => {
      const sourceState = createState({
        status: 'failure',
        scope: 'directory',
      });
      mockLoadExecutionState.mockResolvedValue(sourceState);
      mockResolveLinearToken.mockResolvedValue(null);
      mockRetryPipelineExecution.mockResolvedValue(createHandle(sourceState));

      // Locking an unrelated worktree key must have no bearing on a
      // directory-scoped execution, which has no project/worktree target.
      acquireSplitLock(LOCK_WS, LOCK_WT);

      const handler = registeredHandlers.get(PIPELINE_CHANNELS.RETRY_EXECUTION);
      const result = await handler?.({}, sourceState.id);

      expect(result).toEqual({ success: true, data: sourceState });
      expect(mockRetryPipelineExecution).toHaveBeenCalledTimes(1);
    });
  });
});
