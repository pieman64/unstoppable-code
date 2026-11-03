import type * as PipelineStore from '@canopy/desktop-shared/pipelines/store';
import type * as ReadDispatchFake from '../../__tests__/helpers/pipeline-read-dispatch-fake';
import * as hostPaths from '../../lib/paths';
const mockGetSharedPipelineSaveImpact = jest.fn<
  Promise<{ automations: Array<{ id: string; name: string; kind: string }> }>,
  [remoteId: string]
>(() => Promise.resolve({ automations: [] }));
jest.mock('../../canopy-runtime/pipeline-definition-dispatch', (): object =>
  jest
    .requireActual<
      typeof ReadDispatchFake
    >('../../__tests__/helpers/pipeline-read-dispatch-fake')
    .createPipelineReadFake(() => {
      const store = jest.requireMock<typeof PipelineStore>(
        '@canopy/desktop-shared/pipelines/store',
      );
      return {
        list: store.listStoredPipelines,
        get: store.getStoredPipeline,
      };
    }),
);
// A shared read checks the account's pipeline capability first.
jest.mock('../../canopy-cloud/client', () => ({
  ...jest.requireActual<object>('../../canopy-cloud/client'),
  assertCanopyCloudCapability: jest.fn(() => Promise.resolve()),
}));
jest.mock('../../pipelines/shared-pipeline-save-impact', () => ({
  getSharedPipelineSaveImpact: (remoteId: string): Promise<unknown> =>
    mockGetSharedPipelineSaveImpact(remoteId),
}));
import * as workspacePersistence from '../../lib/workspace-persistence';
import * as pipelineResourceLanes from '../../pipelines/resource-lanes';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import * as fsPromises from 'node:fs/promises';
import { join } from 'node:path';
import type {
  PersistedChatMessage,
  PersistedChatTab,
  PortalEventEnvelope,
} from '@canopy/desktop-shared/types';
import type {
  PipelineInfo,
  SharedPipelineDetail,
  SharedPipelineSummary,
} from '@canopy/desktop-shared/types/pipeline';
import { PORTAL_EVENT_BATCH_MAX_BYTES } from '@canopy/protocol/portal';
import type { PortalPipelineRunPayload } from '@canopy/protocol/portal';
import {
  getPipeline,
  getPipelineExecution,
  getPipelineLog,
  listPipelineExecutions,
  listPipelineRuns,
  listPipelines,
  listPipelinesStrict,
  cancelPipeline,
  resetSharedPipelineListCacheForTests,
  rerunPipeline,
  resumePipeline,
  retryPipeline,
  runPipeline,
  preparePipelineChatFollowUp,
  readPipelineContent,
  getPortalExistingPipelineShare,
  sharePortalPipeline,
  stateToPortalRun,
} from '../pipelines-service';
import {
  createSharedPipeline,
  getSharedPipeline,
  listSharedPipelines,
  publishPipelinePublicShare,
  updateSharedPipeline,
} from '../../pipelines/canopy-server-client';
import {
  writePipelineRemoteMetadata,
  writeProjectPipelineRemoteMetadata,
} from '../../pipelines/pipeline-service';
import {
  getPackageReadiness,
  getSharedPackageReadinessFromDetail,
} from '../../pipelines/pipeline-package-service';
import {
  listExecutionSummaries,
  loadExecutionState,
} from '@canopy/desktop-shared/node/pipelines/executor/execution-state';
import { cancelPipelineExecution } from '@canopy/desktop-shared/node/pipelines/executor/pipeline-executor';
import type {
  ExecutionState,
  StepOutputEvent,
} from '@canopy/desktop-shared/node/pipelines/executor/types';
import {
  cancelPipelineExecutionFromMain,
  startPipelineExecutionFromMain,
} from '../../pipelines/pipeline-handlers';
import {
  discoverProjectPipelines,
  discoverProjectPipelinesBounded,
  loadProjectPipelineFromDisk,
} from '../../pipelines/project-pipeline-discovery';
import { readAllSidebarItems } from '../../lib/sidebar-items';
import {
  getStoredPipeline,
  getStoredPipelinePath,
  listStoredPipelines,
} from '@canopy/desktop-shared/pipelines/store';
import { setCanopyPortalEventSink } from '../../portal/portal-event-bus';
import { createPipelineRunObservers } from '../../pipelines/pipeline-run-observers';
import { buildPipelineRunArtifactReceipt } from '@canopy/desktop-shared/lib/agent-artifacts';
import { projectChatTabsMaterialization } from '../../ipc/chat-persistence';
import {
  portalEventByteLength,
  splitOversizedPortalSnapshotEvent,
  stampPortalEventRouting,
} from '../../portal/portal-outbox';
import {
  listExecutions,
  rerunExecution,
  resumeExecution,
  retryExecution,
} from '../../canopy-tools/worktree-actions';
import { pinOrgProjectsFlagOff } from '../../__tests__/helpers/org-projects-flag';
import { resourceContextEnabled } from '../../lib/resource-context';
type SharedPipelineListPayload = Awaited<
  ReturnType<typeof listSharedPipelines>
>;
jest.mock('../../lib/resource-context', () => ({
  resourceContextEnabled: jest.fn(() => false),
}));

// This suite covers the legacy (context-free) resource paths.
beforeEach(() => {
  pinOrgProjectsFlagOff();
  jest.mocked(resourceContextEnabled).mockReturnValue(false);
});

jest.mock('node:fs/promises', () => {
  const actual = jest.requireActual<typeof fsPromises>('node:fs/promises');
  return {
    ...actual,
    open: jest.fn(actual.open),
  };
});

jest.mock(
  '@canopy/desktop-shared/node/pipelines/executor/execution-state',
  () => ({
    listExecutionSummaries: jest.fn(),
    loadExecutionState: jest.fn(),
  }),
);

jest.mock(
  '@canopy/desktop-shared/node/pipelines/executor/pipeline-executor',
  () => ({ cancelPipelineExecution: jest.fn() }),
);

jest.mock('../../pipelines/pipeline-handlers', () => ({
  cancelPipelineExecutionFromMain: jest.fn(),
  startPipelineExecutionFromMain: jest.fn(),
}));

jest.mock('../../canopy-tools/worktree-actions', () => ({
  listExecutions: jest.fn(),
  rerunExecution: jest.fn(),
  resumeExecution: jest.fn(),
  retryExecution: jest.fn(),
}));

jest.mock('../../pipelines/canopy-server-client', () => ({
  createSharedPipeline: jest.fn(),
  getSharedPipeline: jest.fn(),
  listSharedPipelines: jest.fn(),
  publishPipelinePublicShare: jest.fn(),
  updateSharedPipeline: jest.fn(),
}));

// CAN-4551: the user pipelines live automations own.
const mockOwnedPipelineIds = jest.fn(
  (): Promise<ReadonlySet<string>> => Promise.resolve(new Set()),
);
jest.mock('../../automations/owned-pipeline', () => ({
  automationOwnedPipelineIds: (): Promise<ReadonlySet<string>> =>
    mockOwnedPipelineIds(),
}));
jest.mock('../../pipelines/pipeline-service', () => ({
  writePipelineRemoteMetadata: jest.fn(() => ({ success: true })),
  writeProjectPipelineRemoteMetadata: jest.fn(() => ({ success: true })),
}));

jest.mock('../../pipelines/pipeline-package-service', () => ({
  getPackageReadiness: jest.fn(),
  getSharedPackageReadinessFromDetail: jest.fn(),
}));

// The shared-pipeline memo clears itself on any account write, so the real
// store is replaced with a seam that lets a case fire that transition. The
// listener list lives inside the factory because `jest.mock` is hoisted above
// every module-scope binding in this file.
jest.mock('../../lib/canopy-cloud-account-store', () => {
  const listeners: Array<() => void> = [];
  return {
    readCanopyCloudAccountWithStatus: jest.fn(() =>
      Promise.resolve({
        status: 'ok',
        entry: { account: { id: 'user-a' }, capabilities: [] },
      }),
    ),
    loadCanopyCloudAccountPublicState: jest.fn(() =>
      Promise.resolve({
        status: 'ok',
        hasApiKey: true,
        capabilities: [],
        account: { id: 'user-a' },
      }),
    ),
    subscribeCanopyCloudAccountChanges: (
      listener: () => void,
    ): (() => void) => {
      listeners.push(listener);
      return (): void => {};
    },
    __emitAccountChange: (): void => {
      for (const listener of listeners) listener();
    },
  };
});

const { __emitAccountChange: emitCanopyCloudAccountChange } = jest.requireMock<{
  __emitAccountChange: () => void;
}>('../../lib/canopy-cloud-account-store');

const mockFindPipelineReceipt = jest.fn();
jest.mock('../../lib/resource-install-receipts', () => ({
  createResourceInstallReceiptsStore: jest.fn(() => ({
    findLocal: mockFindPipelineReceipt,
  })),
}));

jest.mock('../../pipelines/project-pipeline-discovery', () => ({
  discoverProjectPipelines: jest.fn(),
  discoverProjectPipelinesBounded: jest.fn(),
  loadProjectPipelineFromDisk: jest.fn(),
}));

jest.mock('@canopy/desktop-shared/pipelines/store', () => ({
  listStoredPipelines: jest.fn(() => ({ success: true, data: [] })),
  getStoredPipeline: jest.fn(() => ({ success: false, error: 'not found' })),
  getStoredPipelinePath: jest.fn(() => ({
    success: false,
    error: 'not found',
  })),
}));

jest.mock('../../pipelines/execution-runtime', () => ({
  createElectronExecutionRuntime: jest.fn(() => ({
    executionsDir: '/tmp/canopy-test-data/pipeline-executions',
    tempRootDir: '/tmp/canopy-test-temp',
    bundledActionsDir: '/tmp/canopy-test-actions',
    getProjectActionsDir: (repoPath: string): string =>
      `${repoPath}/.canopy/actions`,
    getProjectPipelinesDir: (repoPath: string): string =>
      `${repoPath}/.canopy/pipelines`,
  })),
}));

jest.mock('../../lib/sidebar-items', () => ({
  readAllSidebarItems: jest.fn(),
}));

jest.mock('../../lib/paths', () => ({
  getDataDir: (): string => '/tmp/canopy-test-data',
  getWorktreeDir: jest.fn((): string => '/repo'),
  getWorkspaceWorktreeRootRepoDir: (): string => '/repo',
}));

// CAN-3619: canonical chat reads behind the pipeline_run chat-turn links.
// Each case uses its own worktree so derived link state never leaks.
const mockChatTabsByScope = new Map<string, PersistedChatTab[]>();
const mockTranscriptsByChat = new Map<string, PersistedChatMessage[]>();
const mockChatStateService = {
  getCompatibilityTabs: jest.fn(
    (scope: { projectId: string; worktreeId: string }): Promise<unknown> =>
      Promise.resolve({
        version: 1,
        tabs: (
          mockChatTabsByScope.get(`${scope.projectId}/${scope.worktreeId}`) ??
          []
        ).map((tab) => ({ ...tab, messages: [] })),
        activeTabId: '',
      }),
  ),
  consumeTranscript: jest.fn(
    <T>(
      _scope: { projectId: string; worktreeId: string },
      chatId: string,
      _fullOutputs: boolean,
      consume: (messages: AsyncIterable<PersistedChatMessage>) => Promise<T>,
    ): Promise<T> =>
      consume(
        (async function* (): AsyncGenerator<PersistedChatMessage> {
          for (const message of mockTranscriptsByChat.get(chatId) ?? []) {
            yield await Promise.resolve(message);
          }
        })(),
      ),
  ),
};
// The post-commit chat projection hook is exercised for real; only its
// unrelated Portal chat projections are stubbed.
jest.mock('../chat-service', () => ({
  projectAppAdvisorChatSummaries: jest.fn(() => Promise.resolve()),
  projectAppAdvisorChatSummariesStrict: jest.fn(() => Promise.resolve()),
  projectAppAdvisorChatSummaryRemovals: jest.fn(),
  projectWorktreeChatSummaries: jest.fn(() => Promise.resolve()),
  projectWorktreeChatSummariesStrict: jest.fn(() => Promise.resolve()),
  projectWorktreeChatSummaryRemovals: jest.fn(),
  projectWorktreeChatTodos: jest.fn(() => Promise.resolve()),
  projectWorktreeChatTodosStrict: jest.fn(() => Promise.resolve()),
  projectWorktreeChatTodoRemovals: jest.fn(),
}));
jest.mock('../../portal/adapters/mcp-adapter', () => ({
  projectWorktreeMcpServersForChat: jest.fn(() => Promise.resolve()),
}));
jest.mock('../chat-state-service', () => ({
  getChatStateService: (): typeof mockChatStateService => mockChatStateService,
}));

const mockedLoadExecutionState = jest.mocked(loadExecutionState);
const mockedCancelPipelineExecution = jest.mocked(cancelPipelineExecution);
const mockedStartPipelineExecutionFromMain = jest.mocked(
  startPipelineExecutionFromMain,
);
const mockedCancelPipelineExecutionFromMain = jest.mocked(
  cancelPipelineExecutionFromMain,
);
const mockedDiscoverProjectPipelines = jest.mocked(discoverProjectPipelines);
const mockedCreateSharedPipeline = jest.mocked(createSharedPipeline);
const mockedUpdateSharedPipeline = jest.mocked(updateSharedPipeline);
const mockedWritePipelineRemoteMetadata = jest.mocked(
  writePipelineRemoteMetadata,
);
const mockedWriteProjectPipelineRemoteMetadata = jest.mocked(
  writeProjectPipelineRemoteMetadata,
);
const mockedGetSharedPipeline = jest.mocked(getSharedPipeline);
const mockedListSharedPipelines = jest.mocked(listSharedPipelines);
const mockedGetPackageReadiness = jest.mocked(getPackageReadiness);
const mockedGetSharedPackageReadinessFromDetail = jest.mocked(
  getSharedPackageReadinessFromDetail,
);
const mockedPublishPipelinePublicShare = jest.mocked(
  publishPipelinePublicShare,
);
const mockedDiscoverProjectPipelinesBounded = jest.mocked(
  discoverProjectPipelinesBounded,
);
const mockedLoadProjectPipelineFromDisk = jest.mocked(
  loadProjectPipelineFromDisk,
);
const mockedReadAllSidebarItems = jest.mocked(readAllSidebarItems);
const mockedListStoredPipelines = jest.mocked(listStoredPipelines);
const mockedGetStoredPipeline = jest.mocked(getStoredPipeline);
const mockedGetStoredPipelinePath = jest.mocked(getStoredPipelinePath);
const mockedOpenFile = jest.mocked(fsPromises.open);
const mockedListExecutions = jest.mocked(listExecutions);
const mockedRerunExecution = jest.mocked(rerunExecution);
const mockedResumeExecution = jest.mocked(resumeExecution);
const mockedRetryExecution = jest.mocked(retryExecution);
const actualFsPromises =
  jest.requireActual<typeof fsPromises>('node:fs/promises');

function makePipelineInfo(overrides: Partial<PipelineInfo>): PipelineInfo {
  return {
    id: 'pipeline',
    name: 'Pipeline',
    filename: 'pipeline.yaml',
    description: '',
    icon: '',
    createdAt: '',
    updatedAt: '',
    source: 'project',
    readonly: true,
    ...overrides,
  };
}

function sharedPipelineList(
  data: SharedPipelineListPayload['data'],
): SharedPipelineListPayload {
  return { data, nextCursor: null };
}

function makeSharedPipelineDetail(
  overrides: Partial<SharedPipelineDetail> = {},
): SharedPipelineDetail {
  return {
    id: 'remote-1',
    name: 'Ship it',
    description: '',
    icon: '',
    version: '1',
    triggerTypes: ['dispatch'],
    createdBy: { id: 'user-1', name: 'User' },
    shareScope: 'organization',
    owner: { type: 'organization', id: 'org-1', name: 'Organization' },
    createdAt: '',
    updatedAt: '',
    canUpdate: false,
    canDelete: false,
    rawPipeline: 'name: Ship it\njobs: {}',
    contentHash: 'content-hash',
    ...overrides,
  };
}

function makeState(logFile: string): ExecutionState {
  const state: ExecutionState = {
    version: 4,
    id: 'exec-1',
    pipeline_id: 'pipe-1',
    pipeline_snapshot: {
      name: 'Pipeline',
      scope: ['directory'],
      jobs: {
        'job-1': {
          name: 'Build',
          needs: [],
          timeout_minutes: 0,
          max_retries: 0,
          continue_on_error: false,
          steps: [
            {
              id: 'step-1',
              name: 'Test',
              shell: 'bash',
              continue_on_error: false,
              timeout_minutes: 0,
              skip_on_missing_action: false,
            },
          ],
        },
      },
    },
    status: 'running',
    jobs: {
      'job-1': {
        status: 'running',
        steps: {
          'step-1': {
            status: 'success',
            outputs: {},
            dynamic_env: {},
            log_file: logFile,
          },
        },
        outputs: {},
        retry_count: 0,
        iteration_count: 1,
      },
    },
    job_definitions: {},
    job_groups: {},
    pending_pauses: [],
    status_reasons: [],
    started_at: '2026-05-06T00:00:00.000Z',
    cwd: '/tmp',
    project_id: 'ws-1',
    worktree_id: 'wt-1',
    env: {},
    inputs: {},
    report_outputs: {},
  };
  // Preserve legacy fields in these v4 fixtures without widening the current
  // ExecutionState contract.
  Reflect.set(state, 'trigger_inputs', {});
  Reflect.set(state, 'execution_source', 'local');
  return state;
}

async function waitForEventCount(
  events: PortalEventEnvelope[],
  expectedCount: number,
): Promise<void> {
  await waitForCondition(
    () => events.length >= expectedCount,
    `${expectedCount} Portal event(s); received ${events.length}`,
  );
}

async function flushPromises(): Promise<void> {
  await new Promise((resolve) => setImmediate(resolve));
}

function createDeferred<T>(): {
  promise: Promise<T>;
  resolve: (value: T | PromiseLike<T>) => void;
} {
  let resolveDeferred: ((value: T | PromiseLike<T>) => void) | undefined;
  const promise = new Promise<T>((resolve) => {
    resolveDeferred = resolve;
  });
  if (!resolveDeferred) {
    throw new Error('Expected deferred resolver to be initialized');
  }
  return { promise, resolve: resolveDeferred };
}

async function waitForCondition(
  condition: () => boolean,
  description: string,
  timeoutMs = 5_000,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (condition()) return;
    await new Promise<void>((resolve) => setTimeout(resolve, 10));
  }
  throw new Error(`Timed out waiting for ${description}`);
}

function runUpsertLocalIds(events: PortalEventEnvelope[]): string[] {
  return events.flatMap((event) => {
    if (event.type !== 'portal.pipeline.event') return [];
    const payload = event.payload;
    if (!isRecord(payload) || !isRecord(payload.entity)) return [];
    if (payload.entity.entityType !== 'pipeline_run') return [];
    const localId = payload.entity.localId;
    return typeof localId === 'string' ? [localId] : [];
  });
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

function trimExpectedUtf8Tail(value: string, maxBytes: number): string {
  const bytes = Buffer.from(value, 'utf8');
  if (bytes.byteLength <= maxBytes) return value;
  let start = bytes.byteLength - maxBytes;
  while (start < bytes.byteLength && (bytes[start] & 0xc0) === 0x80) {
    start += 1;
  }
  return bytes.subarray(start).toString('utf8');
}

describe('pipelines service portal projection', () => {
  let dir: string;

  beforeEach(async () => {
    mockGetSharedPipelineSaveImpact.mockResolvedValue({ automations: [] });
    jest.clearAllMocks();
    jest.mocked(hostPaths.getWorktreeDir).mockReturnValue('/repo');
    // The shared-pipeline list is memoized across worktrees for one sync pass,
    // so every case starts from a cold read.
    resetSharedPipelineListCacheForTests();
    // `clearAllMocks` clears calls, not implementations, so the stored-pipeline
    // mocks are re-defaulted to "no bundled or user pipelines" per test.
    mockedListSharedPipelines.mockResolvedValue(sharedPipelineList([]));
    mockedGetPackageReadiness.mockResolvedValue({
      status: 'ready',
      requirements: [],
    });
    mockedGetSharedPackageReadinessFromDetail.mockResolvedValue({
      status: 'ready',
      requirements: [],
    });
    mockedListStoredPipelines.mockReturnValue({ success: true, data: [] });
    mockedGetStoredPipeline.mockReturnValue({
      success: false,
      error: 'not found',
    });
    mockedGetStoredPipelinePath.mockReturnValue({
      success: false,
      error: 'not found',
    });
    mockedOpenFile.mockImplementation((path, flags, mode) =>
      actualFsPromises.open(path, flags, mode),
    );
    const executionsDir = '/tmp/canopy-test-data/pipeline-executions';
    await mkdir(executionsDir, { recursive: true });
    dir = await mkdtemp(join(executionsDir, 'canopy-pipeline-service-'));
    mockedDiscoverProjectPipelines.mockResolvedValue([
      {
        id: 'pipe-1',
        name: 'Pipeline',
        description: '',
        icon: '',
        filename: 'pipeline.yaml',
        createdAt: '2026-05-06T00:00:00.000Z',
        updatedAt: '2026-05-06T00:00:00.000Z',
        filePath: join(dir, 'pipeline.yaml'),
        source: 'project',
        readonly: true,
        triggerTypes: ['task_ready'],
        scopes: ['global', 'worktree'],
      },
    ]);
    mockedLoadProjectPipelineFromDisk.mockResolvedValue({
      name: 'Pipeline',
      on: {
        task_ready: {
          inputs: {
            environment: {
              type: 'choice',
              required: true,
              options: ['staging', 'production'],
            },
          },
        },
      },
      jobs: {
        'job-1': {
          steps: [],
        },
      },
    });
    mockedReadAllSidebarItems.mockResolvedValue({
      items: [
        {
          id: 'ws-1',
          type: 'single-repo',
          worktrees: [{ id: 'wt-1' }],
        },
      ],
    } as Awaited<ReturnType<typeof readAllSidebarItems>>);
  });

  afterEach(async () => {
    jest.restoreAllMocks();
    setCanopyPortalEventSink(null);
    await rm(dir, { recursive: true, force: true });
  });

  it.each([
    { organization: false, strict: false },
    { organization: false, strict: true },
    { organization: true, strict: false },
    { organization: true, strict: true },
  ])(
    'filters discovered project inventory for active org=$organization strict=$strict',
    async ({ organization, strict }): Promise<void> => {
      jest.mocked(hostPaths.getWorktreeDir).mockReturnValue(dir);
      jest
        .spyOn(pipelineResourceLanes, 'pipelineResourceContextEnabled')
        .mockReturnValue(true);
      jest
        .spyOn(workspacePersistence, 'readWorkspaceConfigDetailed')
        .mockResolvedValue({
          authority: 'ok',
          ownerMalformed: false,
          memoryMalformed: false,
          config: {
            version: 1,
            type: 'single-repo',
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
      jest
        .spyOn(pipelineResourceLanes, 'assertPipelineContext')
        .mockImplementation(
          (): Promise<void> =>
            organization
              ? Promise.resolve()
              : Promise.reject(
                  new Error('Workflow unavailable (context-mismatch)'),
                ),
        );
      mockedReadAllSidebarItems.mockResolvedValue({
        version: 1,
        items: [
          {
            id: 'ws-1',
            type: 'single-repo',
            name: 'Org checkout',
            repoPath: dir,
            color: '',
            worktrees: [],
            collapsed: false,
            order: 0,
          },
        ],
      });
      await writeFile(
        join(dir, 'pipeline.yaml'),
        'name: Pipeline\non: dispatch\njobs: {}',
      );
      const rows = await discoverProjectPipelines(dir);
      mockedDiscoverProjectPipelinesBounded.mockResolvedValue({
        pipelines: rows,
        truncated: false,
      });
      // Live target resolution uses the host checkout path.
      mockedReadAllSidebarItems.mockResolvedValue({
        version: 1,
        items: [
          {
            id: 'ws-1',
            type: 'single-repo',
            name: 'Org checkout',
            repoPath: dir,
            color: '',
            worktrees: [{ id: 'wt-1', branchName: 'main', createdAt: '' }],
            collapsed: false,
            order: 0,
          },
        ],
      });
      const live = strict
        ? (
            await listPipelinesStrict({
              workspaceLocalId: 'ws-1',
              worktreeLocalId: 'wt-1',
              cwd: dir,
            })
          ).pipelines
        : await listPipelines({ projectId: 'ws-1', worktreeId: 'wt-1' });
      expect(live.map((row) => row.pipelineId)).toEqual(
        organization ? ['pipe-1'] : [],
      );
    },
  );

  it.each([
    { strict: false, target: 'personal', enabled: true },
    { strict: true, target: 'personal', enabled: true },
    { strict: false, target: 'org-a', enabled: true },
    { strict: true, target: 'org-a', enabled: true },
    { strict: false, target: 'personal', enabled: false },
    { strict: true, target: 'personal', enabled: false },
  ])(
    'filters stored inventory against $target strict=$strict enabled=$enabled',
    async ({ strict, target, enabled }): Promise<void> => {
      jest.mocked(hostPaths.getWorktreeDir).mockReturnValue(dir);
      jest
        .spyOn(pipelineResourceLanes, 'pipelineResourceContextEnabled')
        .mockReturnValue(enabled);
      jest
        .spyOn(pipelineResourceLanes, 'pipelineContextSnapshot')
        .mockResolvedValue('org-a');
      jest
        .spyOn(pipelineResourceLanes, 'assertPipelineContextSnapshot')
        .mockResolvedValue();
      mockFindPipelineReceipt.mockResolvedValue({
        accountId: 'user-a',
        receipt: {
          family: 'pipelines',
          remoteId: 'remote-a',
          localResourceIds: ['pipe-1'],
          shareScope: 'organization',
          ownerContext: { kind: 'organization', organizationId: 'org-a' },
          hash: 'hash',
          authorizedAt: '2026-09-24T00:00:00Z',
        },
      });
      mockedGetSharedPipeline.mockResolvedValue({
        id: 'remote-a',
        name: 'Stored',
        description: '',
        icon: '',
        version: '1',
        triggerTypes: ['dispatch'],
        createdBy: { id: 'user-a', name: 'User A' },
        createdAt: '',
        updatedAt: '',
        canUpdate: false,
        canDelete: false,
        rawPipeline: 'name: Stored',
        contentHash: 'hash',
        shareScope: 'organization',
        owner: { type: 'organization', id: 'org-a', name: 'Org A' },
      });
      // Active Org A permits the row; a Personal execution target must still exclude it.
      jest
        .spyOn(pipelineResourceLanes, 'assertPipelineContext')
        .mockImplementation((_resource, projectId): Promise<void> => {
          if (enabled && projectId === 'personal')
            return Promise.reject(
              new Error('Workflow unavailable (context-mismatch)'),
            );
          return Promise.resolve();
        });
      const rows = await discoverProjectPipelines(dir);
      mockedListStoredPipelines.mockReturnValue({
        success: true,
        data: rows.map((row) => ({ ...row, source: 'user' })),
      });
      mockedGetStoredPipelinePath.mockReturnValue({
        success: true,
        data: join(dir, 'stored.yaml'),
      });
      mockedDiscoverProjectPipelines.mockResolvedValue([]);
      mockedDiscoverProjectPipelinesBounded.mockResolvedValue({
        pipelines: [],
        truncated: false,
      });
      mockedReadAllSidebarItems.mockResolvedValue({
        version: 1,
        items: [
          {
            id: target,
            name: 'Target',
            type: 'single-repo',
            repoPath: dir,
            color: '',
            worktrees: [{ id: 'wt-1', branchName: 'main', createdAt: '' }],
            collapsed: false,
            order: 0,
          },
        ],
      });
      const result = strict
        ? (
            await listPipelinesStrict({
              workspaceLocalId: target,
              worktreeLocalId: 'wt-1',
              cwd: dir,
            })
          ).pipelines
        : await listPipelines({ projectId: target, worktreeId: 'wt-1' });
      expect(result.map((row) => row.pipelineId)).toEqual(
        strict || (enabled && target === 'personal') ? [] : ['pipe-1'],
      );
    },
  );

  describe('shared cloud pipelines (CAN-3021)', () => {
    function teamPipelineOwner(): NonNullable<SharedPipelineSummary['owner']> {
      const owner: NonNullable<SharedPipelineSummary['owner']> = {
        type: 'organization',
        id: 't-1',
        name: 'Platform',
      };
      // Keep the team-owner wire shape exercised by this legacy fixture even
      // though the current shared-summary type only accepts organization owners.
      if (
        !Reflect.set(owner, 'organization', {
          id: 'org-1',
          name: 'Example Org',
        }) ||
        !Reflect.set(owner, 'type', 'team')
      ) {
        throw new Error('Could not construct the team pipeline owner fixture.');
      }
      return owner;
    }

    function sharedRow(
      overrides: Partial<SharedPipelineSummary> = {},
    ): SharedPipelineSummary {
      return {
        id: 'remote-1',
        name: 'Ship it',
        description: 'Team release pipeline',
        icon: '',
        version: '1',
        triggerTypes: ['plan_ready'],
        createdBy: { id: 'u-1', name: 'Ada' },
        shareScope: 'team',
        owner: teamPipelineOwner(),
        createdAt: '2026-05-06T00:00:00.000Z',
        updatedAt: '2026-05-06T00:00:00.000Z',
        canUpdate: false,
        canDelete: false,
        ...overrides,
      };
    }

    /**
     * Resolve once the shared-pipeline cloud read has actually been issued.
     * `listPipelinesStrict` awaits the checkout and local discovery first, so
     * a case that needs to interleave with the in-flight fetch cannot simply
     * act on the next microtask.
     */
    async function waitForSharedPipelineFetch(): Promise<void> {
      await waitForCondition(
        () => mockedListSharedPipelines.mock.calls.length > 0,
        'the shared-pipeline cloud read to be issued',
      );
    }

    const SHARED_RAW_PIPELINE = [
      'name: Ship it',
      'on:',
      '  plan_ready: {}',
      'jobs:',
      '  build:',
      '    steps:',
      '      - run: echo hi',
    ].join('\n');

    function sharedDetail(
      overrides: Partial<SharedPipelineDetail> = {},
    ): SharedPipelineDetail {
      return {
        ...sharedRow(),
        rawPipeline: SHARED_RAW_PIPELINE,
        contentHash: 'content-hash',
        ...overrides,
      };
    }

    beforeEach(() => {
      mockedDiscoverProjectPipelinesBounded.mockResolvedValue({
        pipelines: [],
        truncated: false,
      });
    });

    it('appends shared rows to the live list with a shared origin and id', async () => {
      mockedListSharedPipelines.mockResolvedValue({
        data: [sharedRow(), sharedRow({ id: 'remote-2', name: 'Hotfix' })],
        nextCursor: null,
      });

      const pipelines = await listPipelines({ projectId: 'ws-1' });

      // Appended AFTER the local rows: `fitPipelineListResult` prefix-cuts, so
      // the tail is what a byte budget drops and a shared row can never evict
      // a local pipeline.
      expect(pipelines.map((pipeline) => pipeline.pipelineId)).toEqual([
        'pipe-1',
        'shared:canopy-cloud:remote-1',
        'shared:canopy-cloud:remote-2',
      ]);
      expect(pipelines[1]).toMatchObject({
        workspaceLocalId: 'ws-1',
        worktreeLocalId: 'wt-1',
        origin: 'shared',
        name: 'Ship it',
        description: 'Team release pipeline',
        // `source` is the FILENAME everywhere in this contract, and a shared
        // pipeline has none.
        source: '',
        scopes: ['directory'],
      });
      // No inputs on a list row: there is no YAML to read them from here. The
      // plan picker hydrates them on select through `getPipeline`.
      expect(pipelines[1]?.planReadyInputs).toBeUndefined();
      // Already cloud-hosted, so not re-shareable.
      expect(pipelines[1]?.shareable).toBeUndefined();
    });

    it('asks the cloud only for plan_ready rows, capped at 50', async () => {
      mockedListSharedPipelines.mockResolvedValue({
        data: Array.from({ length: 60 }, (_unused, index) =>
          sharedRow({ id: `remote-${index}` }),
        ),
        nextCursor: null,
      });

      const result = await listPipelinesStrict({
        workspaceLocalId: 'ws-1',
        worktreeLocalId: 'wt-1',
        cwd: dir,
      });

      expect(mockedListSharedPipelines).toHaveBeenCalledWith(
        {
          limit: 50,
          triggerType: 'plan_ready',
        },
        { personalOnly: true },
      );
      expect(result.pipelines).toHaveLength(50);
    });

    it('keeps the Personal sync inventory stable when the live lane context is enabled', async () => {
      const enabled = jest
        .spyOn(pipelineResourceLanes, 'pipelineResourceContextEnabled')
        .mockReturnValue(true);
      const snapshot = jest
        .spyOn(pipelineResourceLanes, 'pipelineContextSnapshot')
        .mockResolvedValue('current');
      const check = jest
        .spyOn(pipelineResourceLanes, 'assertPipelineContextSnapshot')
        .mockResolvedValue();
      mockedListSharedPipelines.mockResolvedValue(
        sharedPipelineList([sharedRow()]),
      );
      try {
        const first = await listPipelinesStrict({
          workspaceLocalId: 'ws-1',
          worktreeLocalId: 'wt-1',
          cwd: dir,
        });
        const second = await listPipelinesStrict({
          workspaceLocalId: 'ws-1',
          worktreeLocalId: 'wt-1',
          cwd: dir,
        });
        expect(first.pipelines).toHaveLength(1);
        expect(second.pipelines).toHaveLength(1);
        expect(mockedListSharedPipelines).toHaveBeenCalledTimes(1);
      } finally {
        enabled.mockRestore();
        snapshot.mockRestore();
        check.mockRestore();
      }
    });

    it('fetches once per sync pass and stamps each target', async () => {
      // One pass walks every worktree; repeating the identical account-scoped
      // cloud read per worktree is what the memo exists to stop.
      mockedListSharedPipelines.mockResolvedValue(
        sharedPipelineList([sharedRow()]),
      );

      const [first, second] = await Promise.all([
        listPipelinesStrict({
          workspaceLocalId: 'ws-1',
          worktreeLocalId: 'wt-1',
          cwd: dir,
        }),
        listPipelinesStrict({
          workspaceLocalId: 'ws-1',
          worktreeLocalId: 'wt-2',
          cwd: dir,
        }),
      ]);
      const third = await listPipelinesStrict({
        workspaceLocalId: 'ws-2',
        worktreeLocalId: 'wt-9',
        cwd: dir,
      });

      expect(mockedListSharedPipelines).toHaveBeenCalledTimes(1);
      expect(first.pipelines[0]?.worktreeLocalId).toBe('wt-1');
      expect(second.pipelines[0]?.worktreeLocalId).toBe('wt-2');
      expect(third.pipelines[0]).toMatchObject({
        workspaceLocalId: 'ws-2',
        worktreeLocalId: 'wt-9',
      });
    });

    it('fails soft: a cloud error yields no shared rows and does not fail the strict list', async () => {
      // `listPipelinesStrict` is fail-closed because the sync turns absence
      // into cloud REMOVALS — but that contract is about the local inventory.
      // A signed-out or offline desktop must publish its local pipelines
      // unchanged, not wipe them.
      mockedListSharedPipelines.mockRejectedValue(new Error('offline'));
      mockedDiscoverProjectPipelinesBounded.mockResolvedValue({
        pipelines: [
          {
            id: 'pipe-1',
            name: 'Pipeline',
            description: '',
            icon: '',
            filename: 'pipeline.yaml',
            createdAt: '2026-05-06T00:00:00.000Z',
            updatedAt: '2026-05-06T00:00:00.000Z',
            filePath: join(dir, 'pipeline.yaml'),
            source: 'project',
            readonly: true,
            triggerTypes: ['dispatch'],
            scopes: ['worktree'],
          },
        ],
        truncated: false,
      });

      const result = await listPipelinesStrict({
        workspaceLocalId: 'ws-1',
        worktreeLocalId: 'wt-1',
        cwd: dir,
      });

      expect(result.pipelines.map((pipeline) => pipeline.pipelineId)).toEqual([
        'pipe-1',
      ]);
      expect(result.truncated).toBe(false);
    });

    it('fails every worktree after a Personal shared read context mismatch', async () => {
      mockedListSharedPipelines.mockRejectedValue(
        new Error('Workflow unavailable (context-mismatch)'),
      );

      await expect(
        listPipelinesStrict({
          workspaceLocalId: 'ws-1',
          worktreeLocalId: 'wt-1',
          cwd: dir,
        }),
      ).rejects.toThrow('context-mismatch');
      await expect(
        listPipelinesStrict({
          workspaceLocalId: 'ws-1',
          worktreeLocalId: 'wt-2',
          cwd: dir,
        }),
      ).rejects.toThrow('context-mismatch');
      expect(mockedListSharedPipelines).toHaveBeenCalledTimes(1);
    });

    it('drops a shared row past the per-summary budget rather than a local one', async () => {
      mockedDiscoverProjectPipelinesBounded.mockResolvedValue({
        pipelines: [
          {
            id: 'pipe-1',
            name: 'Pipeline',
            description: '',
            icon: '',
            filename: 'pipeline.yaml',
            createdAt: '2026-05-06T00:00:00.000Z',
            updatedAt: '2026-05-06T00:00:00.000Z',
            filePath: join(dir, 'pipeline.yaml'),
            source: 'project',
            readonly: true,
            triggerTypes: ['dispatch'],
            scopes: ['worktree'],
          },
        ],
        truncated: false,
      });
      mockedListSharedPipelines.mockResolvedValue({
        data: [sharedRow({ description: 'd'.repeat(40 * 1024) })],
        nextCursor: null,
      });

      const result = await listPipelinesStrict({
        workspaceLocalId: 'ws-1',
        worktreeLocalId: 'wt-1',
        cwd: dir,
      });

      expect(result.pipelines.map((pipeline) => pipeline.pipelineId)).toEqual([
        'pipe-1',
      ]);
      // The local pipeline survives, and `truncated` stays false: it reports on
      // the LOCAL inventory, which is what the Plugins page renders a warning
      // for — and that page shows no shared rows to explain such a warning
      // with. The shared list is already silently bounded and fails soft.
      expect(result.truncated).toBe(false);
    });

    it('getPipeline hydrates a shared row plan_ready inputs', async () => {
      mockedGetSharedPipeline.mockResolvedValue(
        sharedDetail({
          rawPipeline: [
            'name: Ship it',
            'on:',
            '  plan_ready:',
            '    inputs:',
            '      environment:',
            '        type: choice',
            '        required: true',
            '        options: [staging, production]',
            'jobs:',
            '  build:',
            '    steps:',
            '      - run: echo hi',
          ].join('\n'),
        }),
      );

      const result = await getPipeline({
        pipelineId: 'shared:canopy-cloud:remote-1',
        projectId: 'ws-1',
        worktreeId: 'wt-1',
      });

      expect(mockedGetSharedPipeline).toHaveBeenCalledWith('remote-1');
      expect(result.planReadyInputs?.environment).toMatchObject({
        type: 'choice',
        required: true,
        options: ['staging', 'production'],
      });
      // It never touches the checkout — a shared pipeline has no file there.
      expect(mockedDiscoverProjectPipelines).not.toHaveBeenCalled();
    });

    it('getPipeline reports not_found when the cloud fetch fails', async () => {
      mockedGetSharedPipeline.mockRejectedValue(new Error('403'));

      await expect(
        getPipeline({
          pipelineId: 'shared:canopy-cloud:remote-1',
          projectId: 'ws-1',
          worktreeId: 'wt-1',
        }),
      ).rejects.toMatchObject({ code: 'not_found' });
    });

    it('runPipeline dispatches a shared id with sharedPipeline and no file path', async () => {
      mockedGetSharedPipeline.mockResolvedValue(
        sharedDetail({
          rawPipeline: [
            'name: Ship it',
            'on:',
            '  plan_ready: {}',
            'jobs:',
            '  build:',
            '    steps:',
            '      - run: echo hi',
          ].join('\n'),
        }),
      );
      const state = makeState(join(dir, 'step.log'));
      mockedStartPipelineExecutionFromMain.mockResolvedValue({
        success: true,
        data: state,
      });
      mockedLoadExecutionState.mockResolvedValue(state);

      const result = await runPipeline({
        pipelineId: 'shared:canopy-cloud:remote-1',
        projectId: 'ws-1',
        worktreeId: 'wt-1',
        eventName: 'plan_ready',
        eventData: { plan_ready: { plan_text: 'Ship the thing.' } },
      });

      expect(result.executionId).toBe(state.id);
      const options =
        mockedStartPipelineExecutionFromMain.mock.calls[0]?.[0]?.options;
      expect(options).toMatchObject({
        pipelineId: 'shared:canopy-cloud:remote-1',
        sharedPipeline: { serverId: 'canopy-cloud', remoteId: 'remote-1' },
      });
      // The executor refetches and REPLACES the content, so passing a path
      // would be meaningless here.
      expect(options && 'pipelineFilePath' in options).toBe(false);
    });

    describe('runPipeline Codex speed', () => {
      function mockSharedRun(): void {
        mockedGetSharedPipeline.mockResolvedValue(
          sharedDetail({ rawPipeline: SHARED_RAW_PIPELINE }),
        );
        const state = makeState(join(dir, 'step.log'));
        mockedStartPipelineExecutionFromMain.mockResolvedValue({
          success: true,
          data: state,
        });
        mockedLoadExecutionState.mockResolvedValue(state);
      }

      function sharedRunPayload(
        speedFields: Pick<
          PortalPipelineRunPayload,
          'modelConfig' | 'codexFastModeEnabled'
        >,
      ): PortalPipelineRunPayload {
        return {
          pipelineId: 'shared:canopy-cloud:remote-1',
          projectId: 'ws-1',
          worktreeId: 'wt-1',
          eventName: 'plan_ready',
          eventData: { plan_ready: { plan_text: 'Ship the thing.' } },
          ...speedFields,
        };
      }

      it.each([
        [
          'an exact Regular speed',
          { modelConfig: { speed: 'standard', thinkingLevel: 'high' } },
          { speed: 'standard', fastMode: false, thinkingLevel: 'high' },
        ],
        [
          'an exact Fast speed',
          { modelConfig: { speed: 'fast', fastMode: true } },
          { speed: 'fast', fastMode: true },
        ],
        [
          'a legacy boolean',
          { modelConfig: { fastMode: true } },
          { speed: 'fast', fastMode: true },
        ],
        [
          'the deprecated top-level boolean',
          { codexFastModeEnabled: false },
          { speed: 'standard', fastMode: false },
        ],
      ] as const)(
        'preserves %s exactly',
        async (_label, speedFields, expected): Promise<void> => {
          mockSharedRun();

          await runPipeline(sharedRunPayload(speedFields));

          expect(
            mockedStartPipelineExecutionFromMain.mock.calls[0]?.[0]?.options
              .modelConfig,
          ).toEqual(expected);
        },
      );

      it.each([
        [
          'Ultra fast',
          { modelConfig: { speed: 'ultrafast' } },
          'Workflows do not support Ultra fast. Choose Regular or Fast.',
        ],
        [
          'Ultra fast beside its derived boolean',
          { modelConfig: { speed: 'ultrafast', fastMode: false } },
          'Workflows do not support Ultra fast. Choose Regular or Fast.',
        ],
        [
          'a speed that contradicts its boolean',
          { modelConfig: { speed: 'fast', fastMode: false } },
          'modelConfig.fastMode must match modelConfig.speed.',
        ],
        [
          'an unknown speed',
          {
            modelConfig: {
              speed: 'turbo',
            } as unknown as PortalPipelineRunPayload['modelConfig'],
          },
          'modelConfig.speed must be standard, fast, or ultrafast.',
        ],
      ] as const)(
        'rejects %s before anything is read, registered, or started',
        async (_label, speedFields, message): Promise<void> => {
          mockSharedRun();
          mockedLoadExecutionState.mockClear();

          await expect(
            runPipeline(sharedRunPayload(speedFields), {
              portalCommandId: 'command-1',
            }),
          ).rejects.toMatchObject({ code: 'invalid_payload', message });

          expect(mockedLoadExecutionState).not.toHaveBeenCalled();
          expect(mockedGetSharedPipeline).not.toHaveBeenCalled();
          expect(mockedStartPipelineExecutionFromMain).not.toHaveBeenCalled();
        },
      );
    });

    it('runPipeline refuses before anything starts when the package is not ready', async () => {
      // Only a `package` share can be blocked on local setup, so the detail
      // that carries `distributionMode` is fetched first and drives the gate.
      mockedGetSharedPipeline.mockResolvedValue(
        sharedDetail({
          distributionMode: 'package',
          rawPipeline: SHARED_RAW_PIPELINE,
        }),
      );
      mockedGetSharedPackageReadinessFromDetail.mockResolvedValue({
        status: 'ready',
        distributionMode: 'package',
        requirements: [
          {
            id: 'node',
            kind: 'runtime',
            displayName: 'Node',
            required: true,
            affectedSteps: [],
            setupHint: 'Install Node.js.',
            status: 'missing',
          },
        ],
      });

      await expect(
        runPipeline({
          pipelineId: 'shared:canopy-cloud:remote-1',
          projectId: 'ws-1',
          worktreeId: 'wt-1',
          eventName: 'plan_ready',
          eventData: { plan_ready: { plan_text: 'Ship the thing.' } },
        }),
      ).rejects.toMatchObject({
        code: 'invalid_payload',
        message:
          'This workflow needs setup finished in the desktop app before it can run.',
      });
      expect(mockedStartPipelineExecutionFromMain).not.toHaveBeenCalled();
      // The detail is fetched once and handed to readiness directly. The
      // IPC-shaped `getPackageReadiness` would re-fetch the same remote id, so
      // going through it would cost a second cloud round trip per dispatch.
      expect(mockedGetSharedPipeline).toHaveBeenCalledTimes(1);
      expect(mockedGetPackageReadiness).not.toHaveBeenCalled();
      expect(mockedGetSharedPackageReadinessFromDetail).toHaveBeenCalledTimes(
        1,
      );
    });

    it('runPipeline refuses a package share when the readiness probe throws', async () => {
      // This is the terminal decision — there is no re-render to correct it
      // later — so a probe that failed must not read as "ready".
      mockedGetSharedPipeline.mockResolvedValue(
        sharedDetail({
          distributionMode: 'package',
          rawPipeline: SHARED_RAW_PIPELINE,
        }),
      );
      mockedGetSharedPackageReadinessFromDetail.mockRejectedValue(
        new Error('probe failed'),
      );

      await expect(
        runPipeline({
          pipelineId: 'shared:canopy-cloud:remote-1',
          projectId: 'ws-1',
          worktreeId: 'wt-1',
          eventName: 'plan_ready',
          eventData: { plan_ready: { plan_text: 'Ship the thing.' } },
        }),
      ).rejects.toMatchObject({
        code: 'invalid_payload',
        message:
          'This workflow needs setup finished in the desktop app before it can run.',
      });
      expect(mockedStartPipelineExecutionFromMain).not.toHaveBeenCalled();
    });

    it('runPipeline runs a definition-only share even though readiness calls it invalid', async () => {
      // `getPackageReadiness` reports `status: 'invalid'` for EVERY non-package
      // share, and `definition_only` is the ordinary share mode — the default
      // whenever packaging is unsupported. Gating on readiness alone refused
      // every plain shared pipeline with a message naming setup that does not
      // exist for it, which made the whole Remote Control feature unusable.
      mockedGetSharedPipeline.mockResolvedValue(
        sharedDetail({
          distributionMode: 'definition_only',
          rawPipeline: SHARED_RAW_PIPELINE,
        }),
      );
      mockedGetSharedPackageReadinessFromDetail.mockResolvedValue({
        status: 'invalid',
        distributionMode: 'definition_only',
        requirements: [],
      });
      const state = makeState(join(dir, 'step.log'));
      mockedStartPipelineExecutionFromMain.mockResolvedValue({
        success: true,
        data: state,
      });
      mockedLoadExecutionState.mockResolvedValue(state);

      const result = await runPipeline({
        pipelineId: 'shared:canopy-cloud:remote-1',
        projectId: 'ws-1',
        worktreeId: 'wt-1',
        eventName: 'plan_ready',
        eventData: { plan_ready: { plan_text: 'Ship the thing.' } },
      });

      expect(result.executionId).toBe(state.id);
      // Readiness is not even consulted for a non-package share.
      expect(mockedGetPackageReadiness).not.toHaveBeenCalled();
      expect(mockedGetSharedPackageReadinessFromDetail).not.toHaveBeenCalled();
      // And the detail is fetched exactly once, not once per gate.
      expect(mockedGetSharedPipeline).toHaveBeenCalledTimes(1);
    });

    it('memoizes a failing cloud read so one pass makes one request', async () => {
      // Worktrees are walked sequentially, so the in-flight dedupe settles
      // before the next one starts. Without a negative memo an offline or
      // rate-limited user re-issued the (internally retried) read once per
      // worktree, turning one pass into dozens of requests.
      mockedListSharedPipelines.mockRejectedValue(new Error('offline'));

      const first = await listPipelinesStrict({
        workspaceLocalId: 'ws-1',
        worktreeLocalId: 'wt-1',
        cwd: dir,
      });
      const second = await listPipelinesStrict({
        workspaceLocalId: 'ws-1',
        worktreeLocalId: 'wt-2',
        cwd: dir,
      });

      expect(mockedListSharedPipelines).toHaveBeenCalledTimes(1);
      // Shared rows stay fail-soft: the pass still completes, just without them.
      expect(
        first.pipelines.filter((row) => row.origin === 'shared'),
      ).toHaveLength(0);
      expect(
        second.pipelines.filter((row) => row.origin === 'shared'),
      ).toHaveLength(0);
    });

    it('drops the memo on a cloud account change', async () => {
      // These rows are stamped onto every worktree document and uploaded under
      // the CURRENT session. A memo filled by the previous account would
      // publish its pipeline names and descriptions under the new identity.
      mockedListSharedPipelines.mockResolvedValue(
        sharedPipelineList([sharedRow()]),
      );

      await listPipelinesStrict({
        workspaceLocalId: 'ws-1',
        worktreeLocalId: 'wt-1',
        cwd: dir,
      });
      expect(mockedListSharedPipelines).toHaveBeenCalledTimes(1);

      // A second read inside the TTL is served from the memo...
      await listPipelinesStrict({
        workspaceLocalId: 'ws-1',
        worktreeLocalId: 'wt-2',
        cwd: dir,
      });
      expect(mockedListSharedPipelines).toHaveBeenCalledTimes(1);

      // ...until sign-out / sign-in / token replacement invalidates it.
      emitCanopyCloudAccountChange();
      mockedListSharedPipelines.mockResolvedValue({
        data: [sharedRow({ id: 'remote-b', name: 'Other account pipeline' })],
        nextCursor: null,
      });

      const after = await listPipelinesStrict({
        workspaceLocalId: 'ws-1',
        worktreeLocalId: 'wt-3',
        cwd: dir,
      });

      expect(mockedListSharedPipelines).toHaveBeenCalledTimes(2);
      expect(
        after.pipelines.some((row) => row.name === 'Other account pipeline'),
      ).toBe(true);
      expect(after.pipelines.some((row) => row.name === 'Ship it')).toBe(false);
    });

    it('refuses to memoize a fetch that was in flight across an account change', async () => {
      // Clearing the memo is not enough on its own: the fetch started under the
      // previous account resolves AFTERWARDS, and an unconditional write would
      // repopulate the memo with that account's rows for the full TTL — the
      // same cross-account leak the subscription exists to prevent, one step
      // later.
      let releaseFirst:
        | ((value: SharedPipelineListPayload) => void)
        | undefined;
      mockedListSharedPipelines.mockReturnValueOnce(
        new Promise((resolve) => {
          releaseFirst = resolve;
        }),
      );

      const inFlight = listPipelinesStrict({
        workspaceLocalId: 'ws-1',
        worktreeLocalId: 'wt-1',
        cwd: dir,
      });
      // The account must change while the fetch is genuinely in flight. Emitting
      // before it starts proves nothing: the fetch would simply capture the new
      // generation and be entitled to write.
      await waitForSharedPipelineFetch();
      emitCanopyCloudAccountChange();
      releaseFirst?.({
        data: [sharedRow({ name: 'Previous account pipeline' })],
        nextCursor: null,
      });
      await inFlight;

      // The next read must go back to the cloud rather than serve the memo...
      mockedListSharedPipelines.mockResolvedValue({
        data: [sharedRow({ id: 'remote-b', name: 'Current account pipeline' })],
        nextCursor: null,
      });
      const after = await listPipelinesStrict({
        workspaceLocalId: 'ws-1',
        worktreeLocalId: 'wt-2',
        cwd: dir,
      });

      expect(mockedListSharedPipelines).toHaveBeenCalledTimes(2);
      // ...and must not carry the previous account's rows.
      expect(
        after.pipelines.some((row) => row.name === 'Previous account pipeline'),
      ).toBe(false);
      expect(
        after.pipelines.some((row) => row.name === 'Current account pipeline'),
      ).toBe(true);
    });

    it('does not let a failure from the previous account suppress the next one', async () => {
      // The rejection path has the same shape: a failure recorded under the old
      // account would otherwise hold off the new account's first fetch for the
      // whole failure TTL.
      let rejectFirst: ((error: Error) => void) | undefined;
      mockedListSharedPipelines.mockReturnValueOnce(
        new Promise((_resolve, reject) => {
          rejectFirst = reject;
        }),
      );

      const inFlight = listPipelinesStrict({
        workspaceLocalId: 'ws-1',
        worktreeLocalId: 'wt-1',
        cwd: dir,
      });
      await waitForSharedPipelineFetch();
      emitCanopyCloudAccountChange();
      rejectFirst?.(new Error('offline'));
      await inFlight;

      mockedListSharedPipelines.mockResolvedValue(
        sharedPipelineList([sharedRow()]),
      );
      const after = await listPipelinesStrict({
        workspaceLocalId: 'ws-1',
        worktreeLocalId: 'wt-2',
        cwd: dir,
      });

      expect(mockedListSharedPipelines).toHaveBeenCalledTimes(2);
      expect(after.pipelines.some((row) => row.origin === 'shared')).toBe(true);
    });

    it('keeps truncated scoped to the local inventory when a shared row is dropped', async () => {
      // `truncated` renders on the web Plugins page, which shows no shared rows
      // at all — so a dropped shared row must not raise a warning about
      // pipelines the reader cannot see.
      mockedListSharedPipelines.mockResolvedValue({
        data: [sharedRow({ description: 'd'.repeat(600 * 1024) })],
        nextCursor: null,
      });

      const result = await listPipelinesStrict({
        workspaceLocalId: 'ws-1',
        worktreeLocalId: 'wt-1',
        cwd: dir,
      });

      expect(
        result.pipelines.filter((row) => row.origin === 'shared'),
      ).toHaveLength(0);
      expect(result.truncated).toBe(false);
    });

    it('answers the live list without shared rows when the cloud stalls', async () => {
      // The live list backs the portal worktree snapshot, which answers a small
      // RPC. The cloud client retries idempotent GETs, so a blackholing server
      // can hold its promise for tens of seconds — long enough that the browser
      // loses the ENTIRE worktree view rather than just the shared rows.
      jest.useFakeTimers();
      try {
        mockedListSharedPipelines.mockReturnValue(new Promise(() => {}));
        mockedDiscoverProjectPipelines.mockResolvedValue([]);

        const pending = listPipelines({
          projectId: 'ws-1',
          worktreeId: 'wt-1',
        });
        // Let the awaits ahead of the cloud read settle, then expire the
        // deadline rather than the (never-settling) request.
        await jest.advanceTimersByTimeAsync(5_000);
        const rows = await pending;

        expect(rows.filter((row) => row.origin === 'shared')).toHaveLength(0);
      } finally {
        jest.useRealTimers();
      }
    });

    it('drops a shared row whose cloud id is not addressable', async () => {
      // The locator validator holds `remoteId` to a narrow charset, so a row
      // outside it would be listed and then fail BOTH hydration and Run with
      // `invalid_payload` — an offer that can never be honored.
      mockedListSharedPipelines.mockResolvedValue({
        data: [
          sharedRow({ id: 'has:colon', name: 'Colon' }),
          sharedRow({ id: '../escape', name: 'Traversal' }),
          sharedRow({ id: 'a'.repeat(129), name: 'Too long' }),
          sharedRow({ id: 'remote-ok', name: 'Addressable' }),
        ],
        nextCursor: null,
      });

      const result = await listPipelinesStrict({
        workspaceLocalId: 'ws-1',
        worktreeLocalId: 'wt-1',
        cwd: dir,
      });

      const shared = result.pipelines.filter((row) => row.origin === 'shared');
      expect(shared.map((row) => row.name)).toEqual(['Addressable']);
    });

    it('getPipeline refuses a shared pipeline that does not declare plan_ready', async () => {
      // This path exists only to hydrate a plan-picker row, and only
      // plan_ready shares are listed — so it must not read back the definition
      // of any other cloud pipeline the account can see.
      mockedGetSharedPipeline.mockResolvedValue(
        sharedDetail({
          distributionMode: 'definition_only',
          rawPipeline: [
            'name: Ship it',
            'on:',
            '  dispatch: {}',
            'jobs:',
            '  build:',
            '    steps:',
            '      - run: echo hi',
          ].join('\n'),
        }),
      );

      await expect(
        getPipeline({
          pipelineId: 'shared:canopy-cloud:remote-1',
          projectId: 'ws-1',
          worktreeId: 'wt-1',
        }),
      ).rejects.toMatchObject({ code: 'not_found' });
    });

    it('runPipeline refuses a shared pipeline that does not declare plan_ready', async () => {
      // The eventName gate is skipped entirely when no eventName is sent, and
      // only plan_ready pipelines are ever listed — so without this check a
      // dispatch that omits eventName could run ANY cloud pipeline the
      // account can read.
      mockedGetSharedPipeline.mockResolvedValue(
        sharedDetail({
          distributionMode: 'definition_only',
          rawPipeline: [
            'name: Ship it',
            'on:',
            '  dispatch: {}',
            'jobs:',
            '  build:',
            '    steps:',
            '      - run: echo hi',
          ].join('\n'),
        }),
      );

      await expect(
        runPipeline({
          pipelineId: 'shared:canopy-cloud:remote-1',
          projectId: 'ws-1',
          worktreeId: 'wt-1',
        }),
      ).rejects.toMatchObject({
        code: 'invalid_payload',
        message: 'The selected workflow does not support plan_ready.',
      });
      expect(mockedStartPipelineExecutionFromMain).not.toHaveBeenCalled();
    });

    it('runPipeline surfaces an unresolvable locator as invalid_payload', async () => {
      // The downgrade story: a stale synced document still offering a shared
      // row to a desktop that no longer understands the id must fail with a
      // readable message inline in the picker, not an opaque
      // `execution_failed`.
      await expect(
        runPipeline({
          pipelineId: 'shared:evil-server:remote-1',
          projectId: 'ws-1',
          worktreeId: 'wt-1',
        }),
      ).rejects.toMatchObject({ code: 'invalid_payload' });
      expect(mockedStartPipelineExecutionFromMain).not.toHaveBeenCalled();
    });
  });

  it('strict listing drops a summary past the serialized budget and reports it', async () => {
    const base = {
      id: 'pipe-1',
      name: 'Pipeline',
      description: '',
      icon: '',
      filename: 'pipeline.yaml',
      createdAt: '2026-05-06T00:00:00.000Z',
      updatedAt: '2026-05-06T00:00:00.000Z',
      filePath: join(dir, 'pipeline.yaml'),
      source: 'project' as const,
      readonly: true,
      triggerTypes: ['dispatch' as const],
      scopes: ['worktree' as const],
    };
    mockedDiscoverProjectPipelinesBounded.mockResolvedValue({
      pipelines: [
        base,
        { ...base, id: 'pipe-2', description: 'd'.repeat(20 * 1024) },
      ],
      truncated: false,
    });
    const result = await listPipelinesStrict({
      workspaceLocalId: 'ws-1',
      worktreeLocalId: 'wt-1',
      cwd: dir,
    });
    expect(result.pipelines.map((pipeline) => pipeline.pipelineId)).toEqual([
      'pipe-1',
    ]);
    expect(result.truncated).toBe(true);
  });

  it('strict listing fails closed when the pipeline store cannot be read (CAN-3019)', async () => {
    // The sync turns absence into removals, so a transient store read error
    // must propagate rather than quietly publishing an inventory with every
    // bundled and user pipeline missing.
    mockedListStoredPipelines.mockReturnValue({
      success: false,
      error: 'EIO',
    });
    mockedDiscoverProjectPipelinesBounded.mockResolvedValue({
      pipelines: [],
      truncated: false,
    });

    await expect(
      listPipelinesStrict({
        workspaceLocalId: 'ws-1',
        worktreeLocalId: 'wt-1',
        cwd: dir,
      }),
    ).rejects.toThrow(/EIO/);
  });

  it('the live list stays lenient when the pipeline store cannot be read (CAN-3019)', async () => {
    // The live command answers a user's own request; an unreadable store
    // degrades to the project pipelines rather than failing the whole panel.
    mockedListStoredPipelines.mockReturnValue({
      success: false,
      error: 'EIO',
    });
    mockedDiscoverProjectPipelines.mockResolvedValue([
      makePipelineInfo({
        id: 'pipe-1',
        name: 'Project Pipeline',
        filename: 'pipeline.yaml',
        filePath: join(dir, 'pipeline.yaml'),
        triggerTypes: ['dispatch'],
      }),
    ]);

    await expect(listPipelines({ projectId: 'ws-1' })).resolves.toMatchObject([
      { pipelineId: 'pipe-1', origin: 'project' },
    ]);
  });

  it('strict listing drops a pipeline whose re-read definition is alias-amplified', async () => {
    const base = {
      id: 'pipe-1',
      name: 'Pipeline',
      description: '',
      icon: '',
      filename: 'pipeline.yaml',
      createdAt: '2026-05-06T00:00:00.000Z',
      updatedAt: '2026-05-06T00:00:00.000Z',
      filePath: join(dir, 'pipeline.yaml'),
      source: 'project' as const,
      readonly: true,
      triggerTypes: ['task_ready' as const],
      scopes: ['worktree' as const],
    };
    mockedDiscoverProjectPipelinesBounded.mockResolvedValue({
      pipelines: [base],
      truncated: false,
    });
    // The inputs are small; an unrelated part of the definition shares one
    // object 8^8 times, as YAML aliases would.
    let amplified: unknown = { k: [1, 2, 3, 4, 5, 6, 7, 8] };
    for (let level = 0; level < 8; level += 1) {
      amplified = Array(8).fill(amplified);
    }
    const definition: Awaited<ReturnType<typeof loadProjectPipelineFromDisk>> =
      {
        name: 'Pipeline',
        on: {
          task_ready: {
            inputs: { environment: { type: 'choice', options: ['staging'] } },
          },
        },
        jobs: { 'job-1': { steps: [] } },
      };
    // `env` values are typed as strings; the amplified object is attached
    // the way a parsed YAML alias would reach it, past the static type.
    Object.assign(definition.jobs['job-1'] ?? {}, { env: { amplified } });
    mockedLoadProjectPipelineFromDisk.mockResolvedValue(definition);
    const started = Date.now();
    const result = await listPipelinesStrict({
      workspaceLocalId: 'ws-1',
      worktreeLocalId: 'wt-1',
      cwd: dir,
    });
    expect(Date.now() - started).toBeLessThan(5_000);
    expect(result.pipelines).toEqual([]);
    expect(result.truncated).toBe(true);
  });

  it.each([
    { required: true, expected: true },
    { required: true, default: false, expected: false },
    { required: false, expected: false },
  ])(
    'projects dispatch input requirements: %j',
    async ({ expected, ...input }) => {
      mockedDiscoverProjectPipelinesBounded.mockResolvedValue({
        pipelines: [
          {
            id: 'pipe-1',
            name: 'Pipeline',
            description: '',
            icon: '',
            filename: 'pipeline.yaml',
            createdAt: '',
            updatedAt: '',
            filePath: join(dir, 'pipeline.yaml'),
            source: 'project',
            readonly: true,
            triggerTypes: ['dispatch'],
            scopes: ['worktree'],
          },
        ],
        truncated: false,
      });
      mockedLoadProjectPipelineFromDisk.mockResolvedValue({
        name: 'Pipeline',
        on: {
          dispatch: { inputs: { confirm: { type: 'boolean', ...input } } },
        },
        jobs: { 'job-1': { steps: [] } },
      });
      const result = await listPipelinesStrict({
        workspaceLocalId: 'ws-1',
        worktreeLocalId: 'wt-1',
        cwd: dir,
      });
      expect(
        result.pipelines.find((row) => row.pipelineId === 'pipe-1')
          ?.hasRequiredInputs,
      ).toBe(expected);
    },
  );

  it('strict listing never syncs credential-like input metadata', async () => {
    const token = 'ghp_strict_list_leak_regression_0123456789';
    mockedDiscoverProjectPipelinesBounded.mockResolvedValue({
      pipelines: [
        {
          id: 'pipe-1',
          name: 'Pipeline',
          description: '',
          icon: '',
          filename: 'pipeline.yaml',
          createdAt: '2026-05-06T00:00:00.000Z',
          updatedAt: '2026-05-06T00:00:00.000Z',
          filePath: join(dir, 'pipeline.yaml'),
          source: 'project',
          readonly: true,
          triggerTypes: ['task_ready', 'plan_ready'],
          scopes: ['worktree'],
        },
      ],
      truncated: false,
    });
    mockedLoadProjectPipelineFromDisk.mockResolvedValue({
      name: 'Pipeline',
      on: {
        task_ready: {
          inputs: {
            api_key: { type: 'string', default: 'looks-harmless' },
            environment: {
              type: 'choice',
              options: ['staging', token],
              default: token,
            },
          },
        },
        plan_ready: {
          inputs: {
            api_key: { type: 'string', default: 'looks-harmless' },
            max_iterations: {
              type: 'choice',
              options: ['3', token],
              default: token,
            },
          },
        },
      },
      jobs: { 'job-1': { steps: [] } },
    });
    const result = await listPipelinesStrict({
      workspaceLocalId: 'ws-1',
      worktreeLocalId: 'wt-1',
      cwd: dir,
    });
    expect(JSON.stringify(result)).not.toContain(token);
    expect(JSON.stringify(result)).not.toContain('looks-harmless');
    // Repository-defined defaults and options never sync; only the
    // inputs' structure does.
    expect(result.pipelines[0]?.taskReadyInputs).toEqual({
      api_key: { type: 'string' },
      environment: { type: 'choice' },
    });
    expect(result.pipelines[0]?.planReadyInputs).toEqual({
      api_key: { type: 'string' },
      max_iterations: { type: 'choice' },
    });
  });

  it('lists only a worktree that belongs to the project and only by a canonical id', async () => {
    await expect(
      listPipelines({ projectId: 'ws-1', worktreeId: 'wt-1' }),
    ).resolves.toHaveLength(1);
    // Unknown worktree: nothing is resolved, so nothing is scanned.
    await expect(
      listPipelines({ projectId: 'ws-1', worktreeId: 'wt-other' }),
    ).resolves.toEqual([]);
    // A non-id can never reach the path join.
    await expect(
      listPipelines({ projectId: 'ws-1', worktreeId: '../../etc' }),
    ).rejects.toMatchObject({ code: 'invalid_payload' });
  });

  it('projects task- and plan-ready trigger metadata for the portal picker', async () => {
    mockedDiscoverProjectPipelines.mockResolvedValue([
      makePipelineInfo({
        id: 'pipe-1',
        name: 'Pipeline',
        filename: 'pipeline.yaml',
        filePath: join(dir, 'pipeline.yaml'),
        triggerTypes: ['task_ready', 'plan_ready'],
        scopes: ['global', 'worktree'],
      }),
    ]);
    mockedLoadProjectPipelineFromDisk.mockResolvedValue({
      name: 'Pipeline',
      on: {
        task_ready: {
          inputs: {
            environment: {
              type: 'choice',
              required: true,
              options: ['staging', 'production'],
            },
          },
        },
        plan_ready: {
          inputs: {
            max_iterations: {
              type: 'number',
              required: true,
              min: 1,
              max: 10,
            },
          },
        },
      },
      jobs: { 'job-1': { steps: [] } },
    });
    await expect(listPipelines({ projectId: 'ws-1' })).resolves.toEqual([
      expect.objectContaining({
        pipelineId: 'pipe-1',
        triggerTypes: ['task_ready', 'plan_ready'],
        scopes: ['global', 'worktree'],
        taskReadyInputs: {
          environment: {
            type: 'choice',
            required: true,
            options: ['staging', 'production'],
          },
        },
        planReadyInputs: {
          max_iterations: {
            type: 'number',
            required: true,
            min: 1,
            max: 10,
          },
        },
      }),
    ]);
  });

  it('reads project pipelines from the first worktree whose checkout exists', async () => {
    // New worktrees lead the manual order and are persisted before their git
    // checkout exists, so the default target skips a row still being set up.
    mockedReadAllSidebarItems.mockResolvedValue({
      items: [
        {
          id: 'ws-1',
          type: 'single-repo',
          worktrees: [
            { id: 'wt-new', setupPhase: 'git-pending' },
            { id: 'wt-ready' },
          ],
        },
      ],
    } as Awaited<ReturnType<typeof readAllSidebarItems>>);

    await listPipelines({ projectId: 'ws-1' });

    expect(hostPaths.getWorktreeDir).toHaveBeenCalledWith('ws-1', 'wt-ready');
    expect(hostPaths.getWorktreeDir).not.toHaveBeenCalledWith('ws-1', 'wt-new');
  });

  it('marks a user pipeline an automation owns, so the Portal folds it (CAN-4551)', async () => {
    mockedListStoredPipelines.mockReturnValue({
      success: true,
      data: [
        {
          id: 'owned-1',
          name: 'Notes',
          filename: 'owned-1.yaml',
          description: '',
          icon: '',
          createdAt: '2026-10-29T00:00:00.000Z',
          updatedAt: '2026-10-29T00:00:00.000Z',
          triggerTypes: ['dispatch'],
          source: 'user',
          readonly: false,
        },
        {
          id: 'mine',
          name: 'Mine',
          filename: 'mine.yaml',
          description: '',
          icon: '',
          createdAt: '2026-10-29T00:00:00.000Z',
          updatedAt: '2026-10-29T00:00:00.000Z',
          triggerTypes: ['dispatch'],
          source: 'user',
          readonly: false,
        },
      ],
    });
    mockedGetStoredPipelinePath.mockImplementation((id: string) => ({
      success: true,
      data: join(dir, `${id}.yaml`),
    }));
    mockedDiscoverProjectPipelines.mockResolvedValue([]);
    mockedLoadProjectPipelineFromDisk.mockResolvedValue({
      name: 'Pipeline',
      on: { dispatch: {} },
      jobs: { 'job-1': { steps: [] } },
    });
    mockOwnedPipelineIds.mockResolvedValueOnce(new Set(['owned-1']));

    const summaries = await listPipelines({ projectId: 'ws-1' });

    expect(
      summaries.map((summary) => [
        summary.pipelineId,
        summary.ownedByAutomation,
      ]),
    ).toEqual([
      ['owned-1', true],
      ['mine', undefined],
    ]);
  });

  it('includes bundled and user pipelines alongside project ones (CAN-3019)', async () => {
    // Remote Control could only ever see project pipelines, so the plan
    // dispatch picker was empty on a worktree whose plan_ready pipelines are
    // the bundled presets and the user's own stored ones.
    mockedListStoredPipelines.mockReturnValue({
      success: true,
      data: [
        makePipelineInfo({
          id: 'refine-plan',
          name: 'Refine Plan',
          filename: 'refine-plan.yaml',
          triggerTypes: ['plan_ready'],
          source: 'bundled',
          readonly: true,
        }),
        makePipelineInfo({
          id: 'my-method',
          name: "Aaron's Multi-Provider Method",
          filename: 'my-method.yaml',
          triggerTypes: ['plan_ready'],
          source: 'user',
          readonly: false,
        }),
      ],
    });
    mockedGetStoredPipelinePath.mockImplementation((id: string) => ({
      success: true,
      data: join(dir, `${id}.yaml`),
    }));
    mockedDiscoverProjectPipelines.mockResolvedValue([
      makePipelineInfo({
        id: 'pipe-1',
        name: 'Project Pipeline',
        filename: 'pipeline.yaml',
        filePath: join(dir, 'pipeline.yaml'),
        triggerTypes: ['plan_ready'],
      }),
    ]);
    mockedLoadProjectPipelineFromDisk.mockResolvedValue({
      name: 'Pipeline',
      on: { plan_ready: {} },
      jobs: { 'job-1': { steps: [] } },
    });

    const summaries = await listPipelines({ projectId: 'ws-1' });

    expect(
      summaries.map((summary) => [summary.pipelineId, summary.origin]),
    ).toEqual([
      ['refine-plan', 'bundled'],
      ['my-method', 'user'],
      ['pipe-1', 'project'],
    ]);
  });

  it('lets a project pipeline shadow a stored one with the same id (CAN-3019)', async () => {
    // Both lists are keyed by bare id and the run command carries only that id,
    // so a collision must resolve the same way in the list and in `runPipeline`
    // — the repo-local definition, being the more specific one, wins.
    mockedListStoredPipelines.mockReturnValue({
      success: true,
      data: [
        makePipelineInfo({
          id: 'shared-id',
          name: 'Bundled version',
          filename: 'bundled.yaml',
          triggerTypes: ['plan_ready'],
          source: 'bundled',
          readonly: true,
        }),
      ],
    });
    mockedDiscoverProjectPipelines.mockResolvedValue([
      makePipelineInfo({
        id: 'shared-id',
        name: 'Project version',
        filename: 'pipeline.yaml',
        filePath: join(dir, 'pipeline.yaml'),
        triggerTypes: ['plan_ready'],
      }),
    ]);
    mockedLoadProjectPipelineFromDisk.mockResolvedValue({
      name: 'Project version',
      on: { plan_ready: {} },
      jobs: { 'job-1': { steps: [] } },
    });

    const summaries = await listPipelines({ projectId: 'ws-1' });

    expect(summaries).toHaveLength(1);
    expect(summaries[0]).toMatchObject({
      pipelineId: 'shared-id',
      name: 'Project version',
      origin: 'project',
    });
  });

  it('loads trigger inputs for a plan-ready-only pipeline', async () => {
    mockedDiscoverProjectPipelines.mockResolvedValue([
      makePipelineInfo({
        id: 'pipe-1',
        name: 'Plan pipeline',
        filename: 'pipeline.yaml',
        filePath: join(dir, 'pipeline.yaml'),
        triggerTypes: ['plan_ready'],
      }),
    ]);
    mockedLoadProjectPipelineFromDisk.mockResolvedValue({
      name: 'Plan pipeline',
      on: {
        plan_ready: {
          inputs: { max_iterations: { type: 'number', default: 3 } },
        },
      },
      jobs: { 'job-1': { steps: [] } },
    });

    await expect(listPipelines({ projectId: 'ws-1' })).resolves.toEqual([
      expect.objectContaining({
        triggerTypes: ['plan_ready'],
        planReadyInputs: {
          max_iterations: { type: 'number', default: 3 },
        },
      }),
    ]);
    expect(mockedLoadProjectPipelineFromDisk).toHaveBeenCalledWith(
      join(dir, 'pipeline.yaml'),
    );
  });

  it.each(['project--ci.yml', 'project--deploy/staging.yaml'])(
    'reads pipeline definition %s into the portal-safe view model without canonical YAML',
    async (pipelineId) => {
      mockedDiscoverProjectPipelines.mockResolvedValueOnce([
        makePipelineInfo({
          id: pipelineId,
          name: 'Pipeline',
          filename: pipelineId.slice('project--'.length),
          filePath: '/repo/.canopy/pipelines/ci.yml',
          triggerTypes: ['task_ready'],
        }),
      ]);
      const result = await getPipeline({
        projectId: 'ws-1',
        pipelineId,
      });
      expect(result.definition.name).toBe('Pipeline');
      expect(result.definition.triggerSummary).toBe('Task ready');
      expect(result.definition.scopes).toEqual(['directory']);
      expect(result.definition.jobs).toEqual([
        { id: 'job-1', name: 'job-1', dependencies: [], steps: [] },
      ]);
      expect(result.definition).not.toHaveProperty('canonicalYaml');
      expect(result.definition).not.toHaveProperty('canonicalYamlTruncated');
    },
  );

  it('does not serialize literal pipeline secrets into the portal response', async () => {
    const literalSecret = 'ghp_portal_pipeline_leak_regression';
    const scriptSecret = 'bearer_portal_pipeline_run_leak_regression';
    mockedDiscoverProjectPipelines.mockResolvedValueOnce([
      makePipelineInfo({
        id: 'project--ci.yml',
        name: 'Pipeline',
        filename: 'ci.yml',
        filePath: '/repo/.canopy/pipelines/ci.yml',
        triggerTypes: ['dispatch'],
      }),
    ]);
    mockedLoadProjectPipelineFromDisk.mockResolvedValueOnce({
      name: 'Pipeline',
      on: { dispatch: {} },
      env: { DEPLOY_TOKEN: literalSecret },
      jobs: {
        deploy: {
          steps: [
            {
              uses: 'acme/deploy@v1',
              with: { token: literalSecret },
            },
            {
              name: 'Deploy script',
              run: `curl -H "Authorization: Bearer ${scriptSecret}" https://example.test/deploy`,
            },
          ],
        },
      },
    });

    const result = await getPipeline({
      projectId: 'ws-1',
      pipelineId: 'project--ci.yml',
    });

    expect(JSON.stringify(result)).not.toContain(literalSecret);
    expect(JSON.stringify(result)).not.toContain(scriptSecret);
    expect(result.definition.jobs[0]?.steps).toEqual([
      expect.objectContaining({
        kind: 'action',
        usesSummary: 'acme/deploy@v1',
      }),
      expect.objectContaining({ kind: 'script', usesSummary: 'Script' }),
    ]);
    expect(result.definition).not.toHaveProperty('canonicalYaml');
  });

  it('getPipeline returns dispatch inputs for a project pipeline (CAN-3174)', async () => {
    mockedLoadProjectPipelineFromDisk.mockResolvedValueOnce({
      name: 'Deploy',
      on: {
        dispatch: {
          inputs: {
            environment: {
              type: 'choice',
              required: true,
              options: ['staging', 'production'],
            },
            hidden_token: {
              type: 'string',
              required: true,
              'hint-hide-ui-option': true,
            },
          },
        },
      },
      jobs: { 'job-1': { steps: [] } },
    });

    const result = await getPipeline({
      pipelineId: 'pipe-1',
      projectId: 'ws-1',
      worktreeId: 'wt-1',
    });

    expect(result.dispatchInputs).toEqual({
      environment: {
        type: 'choice',
        required: true,
        options: ['staging', 'production'],
      },
      hidden_token: {
        type: 'string',
        required: true,
        'hint-hide-ui-option': true,
      },
    });
    expect(result.dispatchUnsupportedReason).toBeUndefined();
  });

  it('getPipeline resolves a bundled or user pipeline the checkout does not hold (CAN-3174)', async () => {
    mockedDiscoverProjectPipelines.mockResolvedValueOnce([]);
    mockedGetStoredPipeline.mockReturnValue({
      success: true,
      data: {
        info: {
          ...makePipelineInfo({
            id: 'review',
            name: 'Review',
            filename: 'review.yaml',
            source: 'bundled',
            readonly: true,
          }),
        },
        content: {
          name: 'Review',
          on: { dispatch: { inputs: { focus: { type: 'string' } } } },
          jobs: { 'job-1': { steps: [] } },
        },
      },
    });

    const result = await getPipeline({
      pipelineId: 'review',
      projectId: 'ws-1',
      worktreeId: 'wt-1',
    });

    expect(result.definition.name).toBe('Review');
    expect(result.dispatchInputs).toEqual({ focus: { type: 'string' } });
  });

  it('getPipeline flags a required json dispatch input (CAN-3174)', async () => {
    mockedLoadProjectPipelineFromDisk.mockResolvedValueOnce({
      name: 'Deploy',
      on: {
        dispatch: { inputs: { payload: { type: 'json', required: true } } },
      },
      jobs: { 'job-1': { steps: [] } },
    });

    const result = await getPipeline({
      pipelineId: 'pipe-1',
      projectId: 'ws-1',
      worktreeId: 'wt-1',
    });

    expect(result.dispatchInputs).toBeUndefined();
    expect(result.dispatchUnsupportedReason).toBe('json_input');
  });

  it('getPipeline omits dispatch fields for a pipeline without the dispatch trigger (CAN-3174)', async () => {
    const result = await getPipeline({
      pipelineId: 'pipe-1',
      projectId: 'ws-1',
      worktreeId: 'wt-1',
    });

    // The default fixture declares only `task_ready`.
    expect(result).not.toHaveProperty('dispatchInputs');
    expect(result).not.toHaveProperty('dispatchUnsupportedReason');
  });

  it('getPipeline still reports not_found for an id neither the checkout nor the store holds (CAN-3174)', async () => {
    mockedDiscoverProjectPipelines.mockResolvedValueOnce([]);

    await expect(
      getPipeline({
        pipelineId: 'ghost',
        projectId: 'ws-1',
        worktreeId: 'wt-1',
      }),
    ).rejects.toMatchObject({ code: 'not_found' });
  });

  it.each([
    { projectId: '', worktreeId: 'wt-1', pipelineId: 'pipe-1' },
    { projectId: 'ws-1', worktreeId: 'wt-1', pipelineId: '' },
  ])('rejects a malformed pipeline locator %#', async (locator) => {
    await expect(getPipeline(locator)).rejects.toMatchObject({
      code: 'invalid_payload',
    });
  });

  it('fails closed when a pipeline locator is unknown', async () => {
    await expect(
      getPipeline({
        projectId: 'ws-1',
        pipelineId: 'missing',
      }),
    ).rejects.toMatchObject({
      code: 'not_found',
      message: 'Workflow not found.',
    });
  });

  it('fails closed when the pipeline project is unknown', async () => {
    await expect(
      getPipeline({ projectId: 'missing', pipelineId: 'pipe-1' }),
    ).rejects.toMatchObject({ code: 'not_found' });
  });

  // CAN-2845: the portal shares a pipeline through the desktop, definition-only.
  describe('sharePortalPipeline', () => {
    // `dir` is created per test, so resolve the path inside the helper.
    async function primeShareablePipeline(): Promise<void> {
      const yamlPath = join(dir, 'share-ci.yml');
      await writeFile(yamlPath, 'name: CI\njobs: {}\n', 'utf8');
      mockedDiscoverProjectPipelines.mockResolvedValue([
        {
          id: 'project--ci.yml',
          name: 'CI',
          filename: 'ci.yml',
          filePath: yamlPath,
          source: 'project',
          readonly: false,
          description: '',
          icon: '',
          createdAt: '',
          updatedAt: '',
        },
      ]);
    }

    it('treats a missing linked Pipeline as unshared after account verification', async () => {
      await primeShareablePipeline();
      const rows = await mockedDiscoverProjectPipelines(dir);
      mockedDiscoverProjectPipelines.mockResolvedValue(
        rows.map((row) => ({
          ...row,
          id: 'local-a',
          source: 'user' as const,
          remote: {
            accountId: 'user-a',
            remoteId: 'missing-pipeline',
            contentHash: 'old-hash',
            shareScope: 'private' as const,
            sharedAt: 'old-u',
          },
        })),
      );
      mockedGetSharedPipeline.mockRejectedValue({ status: 404 });

      await expect(
        getPortalExistingPipelineShare({
          projectId: 'ws-1',
          pipelineId: 'local-a',
        }),
      ).resolves.toBeNull();
    });

    it('passes the main-resolved project source even after its YAML and name change', async (): Promise<void> => {
      await primeShareablePipeline();
      jest
        .spyOn(pipelineResourceLanes, 'pipelineResourceContextEnabled')
        .mockReturnValue(true);
      await writeFile(join(dir, 'share-ci.yml'), 'name: Renamed\njobs: {}\n');
      mockedCreateSharedPipeline.mockResolvedValue({
        id: 'remote-1',
        contentHash: 'new-hash',
        shareScope: 'private',
        updatedAt: 'new-u',
      } as never);
      await sharePortalPipeline({
        projectId: 'ws-1',
        pipelineId: 'project--ci.yml',
        scope: 'private',
      });
      expect(mockedCreateSharedPipeline).toHaveBeenCalledWith({
        rawPipeline: 'name: Renamed\njobs: {}\n',
        shareScope: 'private',
        sourcePipeline: {
          kind: 'project',
          projectId: 'ws-1',
          worktreeId: 'wt-1',
          pipelineFilePath: join(dir, 'share-ci.yml'),
        },
      });
      expect(mockedWriteProjectPipelineRemoteMetadata).toHaveBeenCalledWith(
        join(dir, 'share-ci.yml'),
        {
          accountId: 'user-a',
          remoteId: 'remote-1',
          contentHash: 'new-hash',
          shareScope: 'private',
          sharedAt: 'new-u',
        },
      );
    });

    it.each(['user', 'bundled', 'curated'] as const)(
      'passes the resolved %s source without treating it as a project file',
      async (source): Promise<void> => {
        await primeShareablePipeline();
        jest
          .spyOn(pipelineResourceLanes, 'pipelineResourceContextEnabled')
          .mockReturnValue(true);
        const rows = await mockedDiscoverProjectPipelines(dir);
        mockedDiscoverProjectPipelines.mockResolvedValue(
          rows.map((row) => ({ ...row, source, id: 'local-a' })),
        );
        mockedCreateSharedPipeline.mockResolvedValue(
          makeSharedPipelineDetail({ id: 'remote-1' }),
        );
        await sharePortalPipeline({
          projectId: 'ws-1',
          pipelineId: 'local-a',
          scope: 'private',
        });
        expect(mockedCreateSharedPipeline).toHaveBeenCalledWith(
          expect.objectContaining({
            sourcePipeline: { kind: 'stored', id: 'local-a', source },
          }),
        );
      },
    );

    it('uploads the pipeline YAML verbatim and returns the public link', async () => {
      await primeShareablePipeline();
      mockedCreateSharedPipeline.mockResolvedValue(
        makeSharedPipelineDetail({ id: 'remote-1' }),
      );
      mockedPublishPipelinePublicShare.mockResolvedValue({
        externalId: 'public-1',
        pinnedContentHash: 'content-hash',
        upToDate: true,
        sharePath: '/portal/plugins/pipelines/shared/abc',
        createdAt: '',
        updatedAt: '',
      });

      await expect(
        sharePortalPipeline({
          projectId: 'ws-1',
          pipelineId: 'project--ci.yml',
          scope: 'public',
        }),
      ).resolves.toEqual({ sharePath: '/portal/plugins/pipelines/shared/abc' });

      expect(mockedCreateSharedPipeline).toHaveBeenCalledWith({
        rawPipeline: 'name: CI\njobs: {}\n',
        shareScope: 'private',
      });
    });

    it.each([false, true])(
      'updates the linked pipeline, preserving a locked legacy link (policy %s)',
      async (policyEnabled) => {
        jest.mocked(resourceContextEnabled).mockReturnValue(policyEnabled);
        await primeShareablePipeline();
        const rows = await mockedDiscoverProjectPipelines(dir);
        mockedDiscoverProjectPipelines.mockResolvedValue(
          rows.map((row) => ({
            ...row,
            id: 'local-a',
            source: 'user' as const,
            remote: {
              accountId: 'user-a',
              remoteId: 'remote-1',
              contentHash: 'old-hash',
              shareScope: 'private' as const,
              sharedAt: 'old-u',
            },
          })),
        );
        mockedGetSharedPipeline.mockResolvedValue({
          id: 'remote-1',
          contentHash: 'server-hash',
          owner: { type: 'organization', id: 'org-1' },
          publicShare: {
            externalId: 'public-1',
            updatedAt: 'public-u',
          },
        } as never);
        mockedUpdateSharedPipeline.mockResolvedValue({
          id: 'remote-1',
          contentHash: 'new-hash',
          shareScope: 'team',
          updatedAt: 'new-u',
        } as never);
        mockGetSharedPipelineSaveImpact.mockResolvedValue({
          automations: [
            { id: 'automation-1', name: 'Daily review', kind: 'shared' },
          ],
        });

        await expect(
          sharePortalPipeline({
            projectId: 'ws-1',
            pipelineId: 'local-a',
            scope: 'team',
            teamId: 'team-1',
          }),
        ).resolves.toEqual({
          sharePath: '/portal/plugins/pipelines/shared/remote-1',
          message:
            'People using this workflow in their automations will need to approve your changes before they run again.',
        });

        expect(mockedUpdateSharedPipeline).toHaveBeenCalledWith(
          'remote-1',
          'name: CI\njobs: {}\n',
          {
            expectedContentHash: 'server-hash',
            preservePackage: true,
            shareScope: 'team',
            teamId: 'team-1',
            ...(!policyEnabled
              ? {
                  revokePublicShare: {
                    externalId: 'public-1',
                    updatedAt: 'public-u',
                  },
                }
              : {}),
          },
        );
        expect(mockedCreateSharedPipeline).not.toHaveBeenCalled();
        expect(mockedWritePipelineRemoteMetadata).toHaveBeenCalledWith(
          'local-a',
          {
            accountId: 'user-a',
            remoteId: 'remote-1',
            contentHash: 'new-hash',
            shareScope: 'team',
            sharedAt: 'new-u',
          },
        );
      },
    );

    it('keeps the private copy and reports a degraded share when publishing fails', async () => {
      await primeShareablePipeline();
      mockedCreateSharedPipeline.mockResolvedValue(
        makeSharedPipelineDetail({ id: 'remote-1' }),
      );
      mockedPublishPipelinePublicShare.mockRejectedValue(new Error('nope'));

      const outcome = await sharePortalPipeline({
        projectId: 'ws-1',
        pipelineId: 'project--ci.yml',
        scope: 'public',
      });
      expect(outcome.sharePath).toBeUndefined();
      expect(outcome.message).toContain('public link could not be created');
    });

    it('keeps the affected-automation warning when an updated pipeline public link fails', async () => {
      await primeShareablePipeline();
      const rows = await mockedDiscoverProjectPipelines(dir);
      mockedDiscoverProjectPipelines.mockResolvedValue(
        rows.map((row) => ({
          ...row,
          id: 'local-a',
          source: 'user' as const,
          remote: {
            accountId: 'user-a',
            remoteId: 'remote-1',
            contentHash: 'old-hash',
            shareScope: 'private' as const,
            sharedAt: 'old-u',
          },
        })),
      );
      mockedGetSharedPipeline.mockResolvedValue({
        id: 'remote-1',
        contentHash: 'server-hash',
      } as never);
      mockedUpdateSharedPipeline.mockResolvedValue({
        id: 'remote-1',
        contentHash: 'new-hash',
        shareScope: 'private',
        updatedAt: 'new-u',
      } as never);
      mockGetSharedPipelineSaveImpact.mockResolvedValue({
        automations: [
          { id: 'automation-1', name: 'Daily review', kind: 'shared' },
        ],
      });
      mockedPublishPipelinePublicShare.mockRejectedValue(new Error('nope'));

      await expect(
        sharePortalPipeline({
          projectId: 'ws-1',
          pipelineId: 'local-a',
          scope: 'public',
        }),
      ).resolves.toEqual({
        message:
          'Workflow shared privately, but the public link could not be created, and people using this workflow in their automations will need to approve your changes before they run again.',
      });
    });

    it('scopes a team share to the named team', async () => {
      await primeShareablePipeline();
      mockedCreateSharedPipeline.mockResolvedValue(
        makeSharedPipelineDetail({ id: 'remote-1' }),
      );

      const outcome = await sharePortalPipeline({
        projectId: 'ws-1',
        pipelineId: 'project--ci.yml',
        scope: 'team',
        teamId: 'team-1',
      });

      expect(mockedCreateSharedPipeline).toHaveBeenCalledWith(
        expect.objectContaining({ shareScope: 'team', teamId: 'team-1' }),
      );
      expect(outcome.sharePath).toBe(
        '/portal/plugins/pipelines/shared/remote-1',
      );
      expect(mockedPublishPipelinePublicShare).not.toHaveBeenCalled();
    });

    it('fails closed for an unknown pipeline without calling Cloud', async () => {
      await primeShareablePipeline();
      await expect(
        sharePortalPipeline({
          projectId: 'ws-1',
          pipelineId: 'missing',
          scope: 'public',
        }),
      ).rejects.toMatchObject({ code: 'not_found' });
      expect(mockedCreateSharedPipeline).not.toHaveBeenCalled();
    });
  });

  it('pipeline log request returns recent lines for a known execution step', async () => {
    const logFile = join(dir, 'step.log');
    await writeFile(logFile, 'one\ntwo\nthree\n', 'utf8');
    mockedLoadExecutionState.mockResolvedValue(makeState(logFile));

    const result = await getPipelineLog({
      executionId: 'exec-1',
      jobId: 'job-1',
      stepId: 'step-1',
    });

    expect(result.lines).toEqual(['one', 'two', 'three']);
    expect(result.run?.jobs?.[0]?.steps[0]).toMatchObject({
      stepId: 'step-1',
      outputTail: 'one\ntwo\nthree',
    });
  });

  it('bounds pipeline log request lines by the step tail byte budget', async () => {
    const logFile = join(dir, 'oversized-step.log');
    const raw = `${'old output '.repeat(2_000)}\r\nlatest line\r\n`;
    await writeFile(logFile, raw, 'utf8');
    mockedLoadExecutionState.mockResolvedValue(makeState(logFile));

    const result = await getPipelineLog({
      executionId: 'exec-1',
      jobId: 'job-1',
      stepId: 'step-1',
    });

    expect(
      Buffer.byteLength(result.lines.join('\n'), 'utf8'),
    ).toBeLessThanOrEqual(2 * 1024);
    expect(result.lines[result.lines.length - 1]).toBe('latest line');
  });

  it('missing step log returns empty lines without throwing', async () => {
    mockedLoadExecutionState.mockResolvedValue(
      makeState(join(dir, 'missing.log')),
    );

    await expect(
      getPipelineLog({
        executionId: 'exec-1',
        jobId: 'job-1',
        stepId: 'step-1',
      }),
    ).resolves.toMatchObject({ lines: [] });
  });

  it('matches whole-file UTF-8 and CRLF tail semantics with a bounded read', async () => {
    const logFile = join(dir, 'utf8-crlf.log');
    const raw = `prefix\r\n${'🙂 value\r\n'.repeat(800)}`;
    await writeFile(logFile, raw, 'utf8');

    const run = await stateToPortalRun(makeState(logFile));
    const expected = trimExpectedUtf8Tail(raw.replace(/\r\n/g, '\n'), 2 * 1024);
    expect(run?.jobs?.[0]?.steps[0]?.outputTail).toBe(expected);
    expect(Buffer.byteLength(expected, 'utf8')).toBeLessThanOrEqual(2 * 1024);
  });

  it('rejects pipeline log requests scoped to a different worktree', async () => {
    mockedLoadExecutionState.mockResolvedValue(
      makeState(join(dir, 'step.log')),
    );

    await expect(
      getPipelineLog({
        executionId: 'exec-1',
        jobId: 'job-1',
        stepId: 'step-1',
        projectId: 'ws-1',
        worktreeId: 'wt-2',
      }),
    ).rejects.toMatchObject({
      code: 'not_found',
    });
  });

  it('rejects browser supplied pipeline cwd outside the selected worktree', async () => {
    await expect(
      runPipeline({
        projectId: 'ws-1',
        worktreeId: 'wt-1',
        pipelineId: 'pipe-1',
        cwd: '/etc',
      }),
    ).rejects.toMatchObject({
      code: 'invalid_payload',
    });
    expect(mockedDiscoverProjectPipelines).not.toHaveBeenCalled();
  });

  it('runs a bundled or user pipeline the checkout does not hold (CAN-3019)', async () => {
    // The picker now lists bundled and user pipelines, so Run has to resolve
    // them too; resolving only through the checkout answered "Pipeline not
    // found" for everything the desktop offers by default.
    const state = makeState(join(dir, 'step.log'));
    mockedDiscoverProjectPipelines.mockResolvedValueOnce([]);
    mockedGetStoredPipeline.mockReturnValue({
      success: true,
      data: {
        info: {
          ...makePipelineInfo({
            id: 'refine-plan',
            name: 'Refine Plan',
            filename: 'refine-plan.yaml',
            source: 'bundled',
            readonly: true,
          }),
        },
        content: {
          name: 'Refine Plan',
          on: { plan_ready: {} },
          jobs: { 'job-1': { steps: [] } },
        },
      },
    });
    mockedStartPipelineExecutionFromMain.mockResolvedValue({
      success: true,
      data: state,
    });
    mockedLoadExecutionState.mockResolvedValue(state);

    await expect(
      runPipeline({
        projectId: 'ws-1',
        worktreeId: 'wt-1',
        pipelineId: 'refine-plan',
        eventName: 'plan_ready',
        eventData: { plan_ready: { plan_text: 'The plan' } },
      }),
    ).resolves.toEqual({ executionId: state.id });

    const call = mockedStartPipelineExecutionFromMain.mock.calls[0][0];
    expect(call.pipeline).toMatchObject({ name: 'Refine Plan' });
    // Stored pipelines carry no checkout path, and the desktop's own
    // plan-ready run does not send one either.
    expect(call.options.pipelineFilePath).toBeUndefined();
    expect(call.options.pipelineId).toBe('refine-plan');
  });

  it('still rejects a pipeline id neither the checkout nor the store holds (CAN-3019)', async () => {
    mockedDiscoverProjectPipelines.mockResolvedValueOnce([]);

    await expect(
      runPipeline({
        projectId: 'ws-1',
        worktreeId: 'wt-1',
        pipelineId: 'nope',
      }),
    ).rejects.toMatchObject({ code: 'not_found' });
  });

  it('runs the project pipeline locator returned by portal inventory', async () => {
    const state = makeState(join(dir, 'step.log'));
    mockedDiscoverProjectPipelines.mockResolvedValueOnce([
      makePipelineInfo({
        id: 'project--ci.yml',
        name: 'Pipeline',
        filename: 'ci.yml',
        filePath: join(dir, 'ci.yml'),
        triggerTypes: ['dispatch'],
      }),
    ]);
    mockedStartPipelineExecutionFromMain.mockResolvedValue({
      success: true,
      data: state,
    });
    mockedLoadExecutionState.mockResolvedValue(state);

    await expect(
      runPipeline({
        projectId: 'ws-1',
        worktreeId: 'wt-1',
        pipelineId: 'project--ci.yml',
      }),
    ).resolves.toEqual({ executionId: 'exec-1' });
  });

  it('preserves legacy plan targeting without an eventName', async () => {
    const state = makeState(join(dir, 'step.log'));
    mockedStartPipelineExecutionFromMain.mockResolvedValue({
      success: true,
      data: state,
    });
    mockedLoadExecutionState.mockResolvedValue(state);

    await expect(
      runPipeline({
        projectId: 'ws-1',
        worktreeId: 'wt-1',
        pipelineId: 'pipe-1',
        planId: 'plan-legacy',
      }),
    ).resolves.toEqual({ executionId: 'exec-1' });

    expect(
      mockedStartPipelineExecutionFromMain.mock.calls[0]?.[0].options,
    ).toEqual(
      expect.objectContaining({
        planId: 'plan-legacy',
        eventName: undefined,
        eventData: undefined,
        initiationSource: 'portal',
        initiator: { kind: 'portal' },
      }),
    );
  });

  it.each([
    {
      eventData: { task_ready: { task_text: 'orphaned' } },
    },
    {
      eventName: 'task_ready' as const,
      eventData: { task_ready: { task_text: '   ' } },
    },
  ])('rejects invalid task-ready event context', async (eventContext) => {
    await expect(
      runPipeline({
        projectId: 'ws-1',
        worktreeId: 'wt-1',
        pipelineId: 'pipe-1',
        ...eventContext,
      }),
    ).rejects.toMatchObject({ code: 'invalid_payload' });
    expect(mockedDiscoverProjectPipelines).not.toHaveBeenCalled();
  });

  it('rejects a non-string task-ready task_text', async () => {
    await expect(
      Reflect.apply(runPipeline, undefined, [
        {
          projectId: 'ws-1',
          worktreeId: 'wt-1',
          pipelineId: 'pipe-1',
          eventName: 'task_ready',
          eventData: { task_ready: { task_text: 42 } },
        },
      ]),
    ).rejects.toMatchObject({ code: 'invalid_payload' });
    expect(mockedDiscoverProjectPipelines).not.toHaveBeenCalled();
  });

  it('rejects plan targeting on task-ready runs', async () => {
    await expect(
      runPipeline({
        projectId: 'ws-1',
        worktreeId: 'wt-1',
        pipelineId: 'pipe-1',
        planId: 'plan-1',
        eventName: 'task_ready',
        eventData: { task_ready: { task_text: 'Implement the task' } },
      }),
    ).rejects.toMatchObject({ code: 'invalid_payload' });
    expect(mockedDiscoverProjectPipelines).not.toHaveBeenCalled();
  });

  it('forwards plan_ready with planId and plan_text to the executor', async () => {
    const state = makeState(join(dir, 'step.log'));
    mockedDiscoverProjectPipelines.mockResolvedValue([
      makePipelineInfo({
        id: 'pipe-1',
        name: 'Plan pipeline',
        filename: 'pipeline.yaml',
        filePath: join(dir, 'pipeline.yaml'),
        triggerTypes: ['plan_ready'],
      }),
    ]);
    mockedLoadProjectPipelineFromDisk.mockResolvedValue({
      name: 'Plan pipeline',
      on: { plan_ready: {} },
      jobs: { 'job-1': { steps: [] } },
    });
    mockedStartPipelineExecutionFromMain.mockResolvedValue({
      success: true,
      data: state,
    });
    mockedLoadExecutionState.mockResolvedValue(state);

    await expect(
      runPipeline({
        projectId: 'ws-1',
        worktreeId: 'wt-1',
        pipelineId: 'pipe-1',
        planId: 'plan-1',
        eventName: 'plan_ready',
        eventData: {
          plan_ready: { plan_text: 'Refine this plan', planId: 'plan-1' },
        },
      }),
    ).resolves.toEqual({ executionId: 'exec-1' });

    const startArgs = mockedStartPipelineExecutionFromMain.mock.calls[0]?.[0];
    expect(startArgs?.options).toEqual(
      expect.objectContaining({
        planId: 'plan-1',
        eventName: 'plan_ready',
        eventData: {
          plan_ready: { plan_text: 'Refine this plan', planId: 'plan-1' },
        },
      }),
    );
  });

  it('validates and forwards a nested-only plan_ready planId', async () => {
    const state = makeState(join(dir, 'step.log'));
    mockedDiscoverProjectPipelines.mockResolvedValue([
      makePipelineInfo({
        id: 'pipe-1',
        name: 'Plan pipeline',
        filename: 'pipeline.yaml',
        filePath: join(dir, 'pipeline.yaml'),
        triggerTypes: ['plan_ready'],
      }),
    ]);
    mockedLoadProjectPipelineFromDisk.mockResolvedValue({
      name: 'Plan pipeline',
      on: { plan_ready: {} },
      jobs: { 'job-1': { steps: [] } },
    });
    mockedStartPipelineExecutionFromMain.mockResolvedValue({
      success: true,
      data: state,
    });
    mockedLoadExecutionState.mockResolvedValue(state);

    await runPipeline({
      projectId: 'ws-1',
      worktreeId: 'wt-1',
      pipelineId: 'pipe-1',
      eventName: 'plan_ready',
      eventData: {
        plan_ready: { plan_text: 'Refine this plan', planId: 'plan-nested' },
      },
    });

    const startArgs = mockedStartPipelineExecutionFromMain.mock.calls[0]?.[0];
    expect(startArgs?.options).toEqual(
      expect.objectContaining({
        planId: 'plan-nested',
        eventData: {
          plan_ready: {
            plan_text: 'Refine this plan',
            planId: 'plan-nested',
          },
        },
      }),
    );
  });

  it('rejects an invalid nested-only plan_ready planId', async () => {
    await expect(
      runPipeline({
        projectId: 'ws-1',
        worktreeId: 'wt-1',
        pipelineId: 'pipe-1',
        eventName: 'plan_ready',
        eventData: {
          plan_ready: { plan_text: 'Refine this plan', planId: '../plan' },
        },
      }),
    ).rejects.toThrow('Invalid planId');
    expect(mockedDiscoverProjectPipelines).not.toHaveBeenCalled();
  });

  it('rejects plan_ready without plan_text', async () => {
    await expect(
      runPipeline({
        projectId: 'ws-1',
        worktreeId: 'wt-1',
        pipelineId: 'pipe-1',
        eventName: 'plan_ready',
        eventData: { plan_ready: {} },
      }),
    ).rejects.toMatchObject({ code: 'invalid_payload' });
    expect(mockedDiscoverProjectPipelines).not.toHaveBeenCalled();
  });

  it('rejects plan-ready execution for task-ready-only pipelines', async () => {
    await expect(
      runPipeline({
        projectId: 'ws-1',
        worktreeId: 'wt-1',
        pipelineId: 'pipe-1',
        eventName: 'plan_ready',
        eventData: { plan_ready: { plan_text: 'Refine this plan' } },
      }),
    ).rejects.toMatchObject({
      code: 'invalid_payload',
      message: 'The selected workflow does not support plan_ready.',
    });
    expect(mockedStartPipelineExecutionFromMain).not.toHaveBeenCalled();
  });

  it('rejects task-ready execution for dispatch-only pipelines', async () => {
    mockedLoadProjectPipelineFromDisk.mockResolvedValueOnce({
      name: 'Dispatch pipeline',
      on: 'dispatch',
      jobs: { 'job-1': { steps: [] } },
    });

    await expect(
      runPipeline({
        projectId: 'ws-1',
        worktreeId: 'wt-1',
        pipelineId: 'pipe-1',
        eventName: 'task_ready',
        eventData: { task_ready: { task_text: 'Implement the task' } },
      }),
    ).rejects.toMatchObject({ code: 'invalid_payload' });
    expect(mockedStartPipelineExecutionFromMain).not.toHaveBeenCalled();
  });

  it('resolves browser supplied relative pipeline cwd from the selected worktree', async () => {
    const state = makeState(join(dir, 'step.log'));
    mockedStartPipelineExecutionFromMain.mockResolvedValue({
      success: true,
      data: state,
    });
    mockedLoadExecutionState.mockResolvedValue(state);

    const eventData = {
      task_ready: {
        task_text: 'Fix the portal task flow',
        task_path: '/tmp/untrusted-task.md',
        plan_path: '/tmp/untrusted-plan.md',
      },
    };
    await expect(
      runPipeline({
        projectId: 'ws-1',
        worktreeId: 'wt-1',
        pipelineId: 'pipe-1',
        cwd: 'repo-subdir',
        eventName: 'task_ready',
        eventData,
      }),
    ).resolves.toEqual({ executionId: 'exec-1' });

    expect(mockedDiscoverProjectPipelines).toHaveBeenCalledWith(
      '/repo/repo-subdir',
    );
    const startArgs = mockedStartPipelineExecutionFromMain.mock.calls[0]?.[0];
    expect(startArgs?.options.cwd).toBe('/repo/repo-subdir');
    expect(startArgs?.options.eventName).toBe('task_ready');
    expect(startArgs?.options.eventData).toEqual({
      task_ready: { task_text: 'Fix the portal task flow' },
    });
  });

  it('uses the portal command id as the durable run receipt on redelivery', async () => {
    const receipt = {
      ...makeState(join(dir, 'step.log')),
      id: 'cmd-1',
    };
    mockedLoadExecutionState
      .mockResolvedValueOnce(null)
      .mockResolvedValueOnce(receipt)
      .mockResolvedValue(receipt);
    mockedStartPipelineExecutionFromMain.mockResolvedValue({
      success: true,
      data: receipt,
    });

    const request = {
      projectId: 'ws-1',
      worktreeId: 'wt-1',
      pipelineId: 'pipe-1',
    };
    await expect(
      runPipeline(request, { portalCommandId: 'cmd-1' }),
    ).resolves.toEqual({ executionId: 'cmd-1' });
    await expect(
      runPipeline(request, { portalCommandId: 'cmd-1' }),
    ).resolves.toEqual({ executionId: 'cmd-1' });

    expect(mockedStartPipelineExecutionFromMain).toHaveBeenCalledTimes(1);
    const startArgs = mockedStartPipelineExecutionFromMain.mock.calls[0]?.[0];
    expect(startArgs?.options.executionId).toBe('cmd-1');
  });

  it('leaves a browser-dispatched run to its command-correlated forwarder', async () => {
    const receipt = { ...makeState(join(dir, 'step.log')), id: 'cmd-dedupe' };
    // First read is the redelivery-receipt probe (no prior execution); every
    // later read is the projection `runPipeline` makes after starting.
    mockedLoadExecutionState
      .mockResolvedValueOnce(null)
      .mockResolvedValue(receipt);
    mockedStartPipelineExecutionFromMain.mockResolvedValue({
      success: true,
      data: receipt,
    });
    await runPipeline(
      { projectId: 'ws-1', worktreeId: 'wt-1', pipelineId: 'pipe-1' },
      { portalCommandId: 'cmd-dedupe' },
    );

    const events: PortalEventEnvelope[] = [];
    setCanopyPortalEventSink((event) => events.push(event));
    const observers = createPipelineRunObservers('cmd-dedupe');
    observers?.onEvent({
      executionId: 'cmd-dedupe',
      type: 'execution.updated',
      state: receipt,
      timestamp: '2026-05-06T00:00:01.000Z',
    });
    // A desktop-started execution fed through the SAME observers is the
    // barrier: once its projection lands, the claimed execution has had every
    // chance to publish and demonstrably did not. Without it this assertion
    // would pass simply because the projection is async.
    observers?.onEvent({
      executionId: 'exec-desktop-barrier',
      type: 'execution.updated',
      state: { ...receipt, id: 'exec-desktop-barrier' },
      timestamp: '2026-05-06T00:00:01.000Z',
    });
    await waitForCondition(
      () => runUpsertLocalIds(events).length > 0,
      'barrier projection for an unclaimed execution',
    );

    expect(runUpsertLocalIds(events)).toEqual(['exec-desktop-barrier']);
  });

  it('drains its dedupe claim when a browser-dispatched run finishes', async () => {
    const receipt = { ...makeState(join(dir, 'step.log')), id: 'cmd-drain' };
    mockedLoadExecutionState
      .mockResolvedValueOnce(null)
      .mockResolvedValue(receipt);
    mockedStartPipelineExecutionFromMain.mockResolvedValue({
      success: true,
      data: receipt,
    });
    await runPipeline(
      { projectId: 'ws-1', worktreeId: 'wt-1', pipelineId: 'pipe-1' },
      { portalCommandId: 'cmd-drain' },
    );

    const events: PortalEventEnvelope[] = [];
    setCanopyPortalEventSink((event) => events.push(event));
    const observers = createPipelineRunObservers('cmd-drain');
    // The terminal event still belongs to the correlated forwarder, but it is
    // what releases the claim.
    observers?.onEvent({
      executionId: 'cmd-drain',
      type: 'execution.completed',
      state: { ...receipt, status: 'success' },
      timestamp: '2026-05-06T00:00:02.000Z',
    });
    // A later event on the same id is ambient again, proving the claim was
    // released rather than held for the process lifetime.
    observers?.onEvent({
      executionId: 'cmd-drain',
      type: 'execution.updated',
      state: receipt,
      timestamp: '2026-05-06T00:00:03.000Z',
    });
    await waitForCondition(
      () => runUpsertLocalIds(events).length > 0,
      'ambient projection after the dedupe claim drained',
    );

    // Exactly one: the terminal event was still suppressed.
    expect(runUpsertLocalIds(events)).toEqual(['cmd-drain']);
  });

  it('wraps invalid pipeline execution scope ids in a portal error', async () => {
    await expect(
      getPipelineLog({
        executionId: 'exec-1',
        jobId: 'job-1',
        stepId: 'step-1',
        projectId: '../ws-1',
      }),
    ).rejects.toMatchObject({
      code: 'invalid_target',
    });
    expect(mockedLoadExecutionState).not.toHaveBeenCalled();
  });

  it('fails closed before controlling an execution outside the target scope', async () => {
    mockedLoadExecutionState.mockResolvedValue(
      makeState(join(dir, 'step.log')),
    );

    await expect(
      resumePipeline({
        executionId: 'exec-1',
        projectId: 'ws-1',
        worktreeId: 'wt-2',
      }),
    ).rejects.toMatchObject({ code: 'not_found' });
    expect(mockedResumeExecution).not.toHaveBeenCalled();
  });

  it('requires the routed workspace and worktree before controlling an execution', async () => {
    mockedLoadExecutionState.mockResolvedValue({
      ...makeState(join(dir, 'step.log')),
      status: 'paused',
    });

    await expect(
      resumePipeline({ executionId: 'exec-1' }),
    ).rejects.toMatchObject({ code: 'invalid_target' });
    expect(mockedLoadExecutionState).not.toHaveBeenCalled();
    expect(mockedResumeExecution).not.toHaveBeenCalled();
  });

  it('cancels through the renderer-broadcasting main-process path', async () => {
    const cancelledState = {
      ...makeState(join(dir, 'step.log')),
      status: 'cancelled' as const,
    };
    const getWindow = jest.fn(() => null);
    mockedLoadExecutionState.mockResolvedValue(cancelledState);
    mockedCancelPipelineExecution.mockResolvedValue(cancelledState);
    mockedCancelPipelineExecutionFromMain.mockResolvedValue(cancelledState);

    await expect(
      cancelPipeline(
        {
          executionId: 'exec-1',
          projectId: 'ws-1',
          worktreeId: 'wt-1',
        },
        { portalCommandId: 'cmd-1', getWindow },
      ),
    ).resolves.toMatchObject({ localId: 'exec-1', status: 'cancelled' });

    expect(mockedCancelPipelineExecutionFromMain).toHaveBeenCalledWith({
      executionId: 'exec-1',
      getWindow,
    });
  });

  it('rejects resume, retry, and rerun when their execution state is ineligible', async () => {
    const runningState = makeState(join(dir, 'step.log'));
    mockedLoadExecutionState.mockResolvedValue(runningState);

    await expect(
      resumePipeline({
        executionId: 'exec-1',
        projectId: 'ws-1',
        worktreeId: 'wt-1',
      }),
    ).rejects.toMatchObject({ code: 'execution_failed' });
    await expect(
      retryPipeline({
        executionId: 'exec-1',
        projectId: 'ws-1',
        worktreeId: 'wt-1',
      }),
    ).rejects.toMatchObject({ code: 'execution_failed' });

    mockedLoadExecutionState.mockResolvedValue({
      ...runningState,
      status: 'success',
      event_name: 'plan_ready',
      inputs_persisted: false,
    });
    await expect(
      rerunPipeline({
        executionId: 'exec-1',
        projectId: 'ws-1',
        worktreeId: 'wt-1',
      }),
    ).rejects.toMatchObject({ code: 'execution_failed' });

    expect(mockedResumeExecution).not.toHaveBeenCalled();
    expect(mockedRetryExecution).not.toHaveBeenCalled();
    expect(mockedRerunExecution).not.toHaveBeenCalled();
  });

  it('forwards exact checkpoint responses and streams resumed execution updates', async () => {
    const pausedState = {
      ...makeState(join(dir, 'step.log')),
      status: 'paused' as const,
    };
    const resumedState = { ...pausedState, status: 'running' as const };
    mockedLoadExecutionState
      .mockResolvedValueOnce(pausedState)
      .mockResolvedValueOnce(resumedState);
    mockedResumeExecution.mockResolvedValue({
      requestId: '',
      ok: true,
      result: { execution: { id: 'exec-1' } },
    });

    await expect(
      resumePipeline(
        {
          executionId: 'exec-1',
          projectId: 'ws-1',
          worktreeId: 'wt-1',
          pauseResponses: [
            {
              checkpointId: 'checkpoint-1',
              jobId: 'job-1',
              stepId: 'step-1',
              answers: { approved: true },
            },
          ],
        },
        { portalCommandId: 'cmd-1' },
      ),
    ).resolves.toMatchObject({ localId: 'exec-1', status: 'running' });

    expect(mockedResumeExecution).toHaveBeenCalledWith(
      {
        type: 'pipeline.execution_resume',
        executionId: 'exec-1',
        pauseResponses: [
          {
            checkpointId: 'checkpoint-1',
            jobId: 'job-1',
            stepId: 'step-1',
            answers: { approved: true },
          },
        ],
      },
      expect.objectContaining({}),
    );
    const runtime = mockedResumeExecution.mock.calls[0]?.[1];
    expect(runtime?.pipelineInitiationSource).toBe('portal');
    expect(runtime?.portalCommandId).toBe('cmd-1');
    expect(typeof runtime?.onPipelineEvent).toBe('function');
    expect(typeof runtime?.onPipelineStepOutput).toBe('function');
  });

  it('uses the portal command receipt to avoid resuming twice on redelivery', async () => {
    const pausedState = {
      ...makeState(join(dir, 'step.log')),
      status: 'paused' as const,
    };
    const resumedState = {
      ...pausedState,
      status: 'running' as const,
      portal_command_ids: ['cmd-1'],
    };
    mockedLoadExecutionState
      .mockResolvedValueOnce(pausedState)
      .mockResolvedValueOnce(resumedState)
      .mockResolvedValue(resumedState);
    mockedResumeExecution.mockResolvedValue({
      requestId: '',
      ok: true,
      result: { execution: { id: pausedState.id } },
    });

    const request = {
      executionId: pausedState.id,
      projectId: 'ws-1',
      worktreeId: 'wt-1',
    };
    await expect(
      resumePipeline(request, { portalCommandId: 'cmd-1' }),
    ).resolves.toMatchObject({ localId: pausedState.id, status: 'running' });
    await expect(
      resumePipeline(request, { portalCommandId: 'cmd-1' }),
    ).resolves.toMatchObject({ localId: pausedState.id, status: 'running' });

    expect(mockedResumeExecution).toHaveBeenCalledTimes(1);
  });

  it('uses the portal command receipt to avoid retrying twice after another failure', async () => {
    const failedState = {
      ...makeState(join(dir, 'step.log')),
      status: 'failure' as const,
    };
    const retriedFailure = {
      ...failedState,
      portal_command_ids: ['cmd-1'],
    };
    mockedLoadExecutionState
      .mockResolvedValueOnce(failedState)
      .mockResolvedValueOnce(retriedFailure)
      .mockResolvedValue(retriedFailure);
    mockedRetryExecution.mockResolvedValue({
      requestId: '',
      ok: true,
      result: { execution: { id: failedState.id } },
    });

    const request = {
      executionId: failedState.id,
      projectId: 'ws-1',
      worktreeId: 'wt-1',
    };
    await expect(
      retryPipeline(request, { portalCommandId: 'cmd-1' }),
    ).resolves.toMatchObject({ localId: failedState.id, status: 'failed' });
    await expect(
      retryPipeline(request, { portalCommandId: 'cmd-1' }),
    ).resolves.toMatchObject({ localId: failedState.id, status: 'failed' });

    expect(mockedRetryExecution).toHaveBeenCalledTimes(1);
    expect(mockedRetryExecution.mock.calls[0]?.[1].portalCommandId).toBe(
      'cmd-1',
    );
  });

  it('uses the portal command id as the durable rerun receipt on redelivery', async () => {
    const source = {
      ...makeState(join(dir, 'step.log')),
      status: 'success' as const,
      event_name: 'dispatch' as const,
      inputs_persisted: true,
    };
    const receipt = {
      ...source,
      id: 'cmd-1',
      status: 'running' as const,
      rerun_source_id: source.id,
    };
    mockedLoadExecutionState
      .mockResolvedValueOnce(null)
      .mockResolvedValueOnce(source)
      .mockResolvedValueOnce(receipt)
      .mockResolvedValue(receipt);
    mockedRerunExecution.mockResolvedValue({
      requestId: '',
      ok: true,
      result: { execution: { id: 'cmd-1' } },
    });

    const request = {
      executionId: source.id,
      projectId: 'ws-1',
      worktreeId: 'wt-1',
    };
    await expect(
      rerunPipeline(request, { portalCommandId: 'cmd-1' }),
    ).resolves.toMatchObject({ localId: 'cmd-1' });
    await expect(
      rerunPipeline(request, { portalCommandId: 'cmd-1' }),
    ).resolves.toMatchObject({ localId: 'cmd-1' });

    expect(mockedRerunExecution).toHaveBeenCalledTimes(1);
    expect(mockedRerunExecution).toHaveBeenCalledWith(
      {
        type: 'pipeline.execution_rerun',
        executionId: source.id,
        rerunExecutionId: 'cmd-1',
      },
      expect.objectContaining({}),
    );
  });

  it('serializes conflicting mutations for one execution across command ids', async () => {
    const source = {
      ...makeState(join(dir, 'step.log')),
      status: 'failure' as const,
      event_name: 'dispatch' as const,
      inputs_persisted: true,
    };
    const retryReceipt = {
      ...source,
      portal_command_ids: ['cmd-retry'],
    };
    const rerunReceipt = {
      ...source,
      id: 'cmd-rerun',
      status: 'running' as const,
      rerun_source_id: source.id,
    };
    let retryFinished = false;
    let rerunStarted = false;
    mockedLoadExecutionState.mockImplementation((executionId) =>
      Promise.resolve(
        executionId === 'cmd-rerun'
          ? rerunStarted
            ? rerunReceipt
            : null
          : retryFinished
            ? retryReceipt
            : source,
      ),
    );
    let finishRetry:
      | ((value: Awaited<ReturnType<typeof retryExecution>>) => void)
      | undefined;
    mockedRetryExecution.mockImplementation(
      () =>
        new Promise((resolve) => {
          finishRetry = (value): void => {
            retryFinished = true;
            resolve(value);
          };
        }),
    );
    mockedRerunExecution.mockImplementation(() => {
      rerunStarted = true;
      return Promise.resolve({
        requestId: '',
        ok: true,
        result: { execution: { id: rerunReceipt.id } },
      });
    });
    const request = {
      executionId: source.id,
      projectId: 'ws-1',
      worktreeId: 'wt-1',
    };

    const retry = retryPipeline(request, { portalCommandId: 'cmd-retry' });
    for (
      let index = 0;
      index < 20 && mockedRetryExecution.mock.calls.length === 0;
      index += 1
    ) {
      await flushPromises();
    }
    const rerun = rerunPipeline(request, { portalCommandId: 'cmd-rerun' });
    await flushPromises();

    expect(mockedRerunExecution).not.toHaveBeenCalled();

    finishRetry?.({
      requestId: '',
      ok: true,
      result: { execution: { id: source.id } },
    });
    await expect(retry).resolves.toMatchObject({ localId: source.id });
    await expect(rerun).resolves.toMatchObject({ localId: rerunReceipt.id });
    expect(mockedRetryExecution).toHaveBeenCalledTimes(1);
    expect(mockedRerunExecution).toHaveBeenCalledTimes(1);
  });

  it('returns a bounded execution-list shape and preserves truncation', async () => {
    const state = makeState(join(dir, 'step.log'));
    mockedListExecutions.mockResolvedValue({
      requestId: '',
      ok: true,
      result: {
        totalMatches: 2,
        returned: 1,
        executions: [{ id: 'exec-1' }],
      },
    });
    mockedLoadExecutionState.mockResolvedValue(state);

    await expect(
      listPipelineExecutions({
        projectId: 'ws-1',
        worktreeId: 'wt-1',
        limit: 1,
      }),
    ).resolves.toMatchObject({
      runs: [{ localId: 'exec-1' }],
      truncated: true,
    });
  });

  it('projects pause checkpoints and status reasons needed for portal resume', async () => {
    const state: ExecutionState = {
      ...makeState(join(dir, 'step.log')),
      status: 'paused',
      parent_execution_id: 'exec-parent',
      hidden: true,
      status_reasons: [
        {
          id: 'reason-1',
          kind: 'input_required',
          code: 'input_requested',
          detected_at: '2026-09-11T12:00:00.000Z',
          source: {
            job_id: 'job-1',
            step_id: 'step-1',
            attempt: 0,
            iteration: 1,
          },
        },
      ],
      pending_pauses: [
        {
          id: 'checkpoint-1',
          kind: 'input',
          job_id: 'job-1',
          logical_job_id: 'job-1',
          step_id: 'step-1',
          attempt: 0,
          iteration: 1,
          detected_at: '2026-09-11T12:00:00.000Z',
          request: {
            title: 'Release approval',
            message: 'Choose whether to deploy.',
            fields: [
              {
                key: 'approved',
                label: 'Approve release',
                type: 'boolean',
                required: true,
                default: false,
              },
            ],
          },
        },
      ],
    };

    await expect(stateToPortalRun(state)).resolves.toMatchObject({
      parentExecutionId: 'exec-parent',
      hidden: true,
      statusReasons: [
        {
          id: 'reason-1',
          kind: 'input_required',
          code: 'input_requested',
        },
      ],
      pendingPauses: [
        {
          id: 'checkpoint-1',
          kind: 'input',
          jobId: 'job-1',
          logicalJobId: 'job-1',
          stepId: 'step-1',
          request: {
            title: 'Release approval',
            message: 'Choose whether to deploy.',
            fields: [
              {
                key: 'approved',
                label: 'Approve release',
                type: 'boolean',
                required: true,
                default: false,
              },
            ],
          },
        },
      ],
    });
  });

  it('keeps oversized pause checkpoints deliverable in live events and snapshots', async () => {
    const state: ExecutionState = {
      ...makeState(join(dir, 'step.log')),
      status: 'paused',
      pending_pauses: [
        {
          id: 'checkpoint-oversized',
          kind: 'input',
          job_id: 'job-1',
          logical_job_id: 'job-1',
          step_id: 'step-1',
          attempt: 0,
          iteration: 1,
          detected_at: '2026-09-11T12:00:00.000Z',
          request: {
            title: 'Large request',
            message: 'x'.repeat(PORTAL_EVENT_BATCH_MAX_BYTES * 2),
            fields: [
              {
                key: 'approved',
                label: 'Approve release',
                type: 'boolean',
                required: true,
              },
            ],
          },
        },
      ],
    };

    const run = await stateToPortalRun(state);
    expect(run?.pendingPauses?.[0]).toMatchObject({
      id: 'checkpoint-oversized',
      jobId: 'job-1',
      logicalJobId: 'job-1',
      stepId: 'step-1',
      requestUnavailableReason: 'too_large',
    });
    expect(run?.pendingPauses?.[0]?.request).toBeUndefined();

    const entity = {
      entityType: 'pipeline_run' as const,
      localId: state.id,
      parentLocalId: 'ws-1:wt-1',
      payload: run,
    };
    const liveEvent: PortalEventEnvelope = {
      type: 'portal.pipeline.event',
      eventId: 'live-oversized-checkpoint',
      occurredAt: '2026-09-11T12:00:01.000Z',
      payload: { kind: 'upsert', entity },
    };
    expect(portalEventByteLength(liveEvent)).toBeLessThanOrEqual(
      PORTAL_EVENT_BATCH_MAX_BYTES,
    );

    const snapshotEvent: PortalEventEnvelope = {
      type: 'portal.state.snapshot',
      eventId: 'snapshot-oversized-checkpoint',
      occurredAt: '2026-09-11T12:00:02.000Z',
      payload: {
        scope: 'pipelines',
        target: {
          workspaceLocalId: 'ws-1',
          worktreeLocalId: 'wt-1',
        },
        entities: [entity],
      },
    };
    const recovered = splitOversizedPortalSnapshotEvent(
      snapshotEvent,
      PORTAL_EVENT_BATCH_MAX_BYTES,
    );
    expect(recovered).toEqual({
      events: [snapshotEvent],
      droppedEntityCount: 0,
      droppedEntityMarker: null,
    });
    expect(
      portalEventByteLength(recovered?.events[0] ?? snapshotEvent),
    ).toBeLessThanOrEqual(PORTAL_EVENT_BATCH_MAX_BYTES);
  });

  it('degrades a pipeline run whose skeleton cannot fit one portal event', async () => {
    const oversizedState = makeState(join(dir, 'oversized-skeleton.log'));
    oversizedState.status = 'paused';
    oversizedState.pending_pauses = [
      {
        id: 'checkpoint-oversized-run',
        kind: 'input',
        job_id: 'job-1',
        logical_job_id: 'job-1',
        step_id: 'step-0',
        attempt: 0,
        iteration: 1,
        detected_at: '2026-09-11T12:00:00.000Z',
        request: {
          title: 'Approval',
          message: 'Approve this run.',
          fields: [
            {
              key: 'approved',
              label: 'Approve',
              type: 'boolean',
              required: true,
            },
          ],
        },
      },
    ];
    const stepCount = 300;
    oversizedState.pipeline_snapshot.jobs['job-1'].steps = Array.from(
      { length: stepCount },
      (_, index) => ({
        id: `step-${index}`,
        name: `Step ${index} ${'x'.repeat(4096)}`,
        shell: 'bash',
        continue_on_error: false,
        timeout_minutes: 0,
        skip_on_missing_action: false,
      }),
    );
    oversizedState.jobs['job-1'].steps = {};
    oversizedState.report_outputs = { report_file: '/exec/report.md' };
    mockedLoadExecutionState.mockResolvedValue(oversizedState);
    const events: PortalEventEnvelope[] = [];
    setCanopyPortalEventSink((event) => events.push(event));

    await expect(
      getPipelineExecution({
        executionId: oversizedState.id,
        projectId: 'ws-1',
        worktreeId: 'wt-1',
      }),
    ).resolves.toMatchObject({ localId: oversizedState.id });

    expect(events).toHaveLength(1);
    expect(portalEventByteLength(events[0])).toBeLessThanOrEqual(
      PORTAL_EVENT_BATCH_MAX_BYTES,
    );
    const payload = events[0]?.payload;
    const entity = isRecord(payload) ? payload.entity : undefined;
    const run = isRecord(entity) ? entity.payload : undefined;
    expect(run).toMatchObject({
      localId: oversizedState.id,
      pipelineId: oversizedState.pipeline_id,
      workspaceLocalId: 'ws-1',
      worktreeLocalId: 'wt-1',
      // CAN-3719: follow-up availability survives truncation.
      chatFollowUp: { planAvailable: false, reportAvailable: true },
      truncated: true,
    });
    expect(isRecord(run) ? run.jobs : undefined).toBeUndefined();
    expect(isRecord(run) ? run.pendingPauses : undefined).toEqual([
      {
        id: 'checkpoint-oversized-run',
        kind: 'input',
        jobId: 'job-1',
        logicalJobId: 'job-1',
        stepId: 'step-0',
        requestUnavailableReason: 'too_large',
      },
    ]);
  });

  it('bounds a near-limit pipeline event after routing metadata is stamped', async () => {
    const nearLimitState = makeState(join(dir, 'near-limit-skeleton.log'));
    mockedLoadExecutionState.mockResolvedValue(nearLimitState);
    const baseline: PortalEventEnvelope[] = [];
    setCanopyPortalEventSink((event) => baseline.push(event));
    await getPipelineExecution({
      executionId: nearLimitState.id,
      projectId: 'ws-1',
      worktreeId: 'wt-1',
    });
    const baselineBytes = portalEventByteLength(baseline[0]);
    const originalName =
      nearLimitState.pipeline_snapshot.jobs['job-1'].steps[0].name;
    if (originalName === undefined) {
      throw new Error('Expected the pipeline fixture to contain a named step.');
    }
    nearLimitState.pipeline_snapshot.jobs['job-1'].steps[0].name = 'x'.repeat(
      PORTAL_EVENT_BATCH_MAX_BYTES -
        baselineBytes +
        Buffer.byteLength(originalName, 'utf8') -
        1,
    );
    const routed: PortalEventEnvelope[] = [];
    setCanopyPortalEventSink((event) =>
      routed.push(stampPortalEventRouting(event, new Map())),
    );

    await getPipelineExecution({
      executionId: nearLimitState.id,
      projectId: 'ws-1',
      worktreeId: 'wt-1',
    });

    expect(routed).toHaveLength(1);
    expect(portalEventByteLength(routed[0])).toBeLessThanOrEqual(
      PORTAL_EVENT_BATCH_MAX_BYTES,
    );
    const payload = routed[0]?.payload;
    const entity = isRecord(payload) ? payload.entity : undefined;
    expect(isRecord(entity) ? entity.payload : undefined).toMatchObject({
      truncated: true,
    });
  });

  it('run projection populates jobs and caps per-step output tails', async () => {
    const logFile = join(dir, 'long.log');
    await writeFile(logFile, 'x'.repeat(3000), 'utf8');

    const run = await stateToPortalRun(makeState(logFile));

    expect(run?.jobs?.[0]).toMatchObject({
      jobId: 'job-1',
      name: 'Build',
      steps: [
        expect.objectContaining({
          stepId: 'step-1',
          name: 'Test',
          status: 'success',
        }),
      ],
    });
    expect(
      Buffer.byteLength(run?.jobs?.[0]?.steps[0]?.outputTail ?? ''),
    ).toBeLessThanOrEqual(2048);
    // No source data on the desktop side yet for these fields — TODO wires
    // them through `triggerSource` / `progress` later. They must stay
    // undefined on the wire so the renderer's "field omitted" branch wins.
    expect(run?.triggerSource).toBeUndefined();
    expect(run?.progress).toBeUndefined();
  });

  it('emits Portal pipeline_run updates from execution and step-output callbacks', async () => {
    const logFile = join(dir, 'stream.log');
    await writeFile(logFile, '', 'utf8');
    const state = makeState(logFile);
    const events: PortalEventEnvelope[] = [];
    setCanopyPortalEventSink((event) => events.push(event));
    mockedLoadExecutionState.mockResolvedValueOnce(null).mockImplementation(
      () =>
        new Promise((resolve) => {
          setTimeout(() => resolve(state), 25);
        }),
    );
    let capturedArgs:
      | Parameters<typeof startPipelineExecutionFromMain>[0]
      | undefined;
    mockedStartPipelineExecutionFromMain.mockImplementation((args) => {
      capturedArgs = args;
      return Promise.resolve({ success: true, data: state });
    });

    await expect(
      runPipeline(
        {
          projectId: 'ws-1',
          worktreeId: 'wt-1',
          pipelineId: 'pipe-1',
          cwd: '/repo',
        },
        { portalCommandId: 'cmd-1' },
      ),
    ).resolves.toEqual({ executionId: 'exec-1' });

    expect(capturedArgs?.onEvent).toEqual(expect.any(Function));
    expect(capturedArgs?.onStepOutput).toEqual(expect.any(Function));
    expect(capturedArgs?.options).toEqual(
      expect.objectContaining({
        initiationSource: 'portal',
      }),
    );
    events.length = 0;

    capturedArgs?.onEvent?.({
      executionId: state.id,
      type: 'execution.started',
      state,
      timestamp: '2026-05-06T00:00:01.000Z',
    });
    await waitForEventCount(events, 1);

    capturedArgs?.onStepOutput?.({
      executionId: state.id,
      jobId: 'job-1',
      jobName: 'Build',
      stepId: 'step-1',
      stepName: 'Test',
      attempt: 0,
      iteration: 1,
      stream: 'stdout',
      data: 'hello portal\n',
    });
    await waitForEventCount(events, 2);

    const upsertEvent = events.find((event) => {
      if (
        event.type !== 'portal.pipeline.event' ||
        event.commandId !== 'cmd-1'
      ) {
        return false;
      }
      const payload = event.payload;
      if (!isRecord(payload) || !isRecord(payload.entity)) {
        return false;
      }
      return (
        payload.kind === 'upsert' &&
        payload.entity.entityType === 'pipeline_run' &&
        payload.entity.localId === 'exec-1' &&
        payload.entity.parentLocalId === 'ws-1:wt-1'
      );
    });
    expect(upsertEvent).toBeDefined();
    const outputEvent = events.find((event) => {
      const payload = event.payload;
      if (!isRecord(payload) || !isRecord(payload.entity)) {
        return false;
      }
      const run = payload.entity.payload;
      if (!isRecord(run)) {
        return false;
      }
      return (
        typeof run.outputTail === 'string' &&
        run.outputTail.includes('hello portal')
      );
    });
    expect(outputEvent).toBeDefined();
  });

  it('coalesces burst output projections before a terminal update', async () => {
    const logFile = join(dir, 'burst-stream.log');
    await writeFile(logFile, 'stream output', 'utf8');
    const failedState = {
      ...makeState(logFile),
      status: 'failure' as const,
    };
    const runningState = makeState(logFile);
    const terminalState = {
      ...makeState(logFile),
      status: 'success' as const,
      completed_at: '2026-05-06T00:00:02.000Z',
    };
    const firstOutputProjection = createDeferred<ExecutionState | null>();
    mockedLoadExecutionState
      .mockResolvedValueOnce(failedState)
      .mockImplementationOnce(() => firstOutputProjection.promise)
      .mockResolvedValue(runningState);
    let runtime: Parameters<typeof retryExecution>[1] | undefined;
    let finishRetry:
      | ((value: Awaited<ReturnType<typeof retryExecution>>) => void)
      | undefined;
    mockedRetryExecution.mockImplementation((_request, capturedRuntime) => {
      runtime = capturedRuntime;
      return new Promise((resolve) => {
        finishRetry = resolve;
      });
    });
    const updates: PortalEventEnvelope[] = [];
    setCanopyPortalEventSink((event) => updates.push(event));

    const retry = retryPipeline(
      {
        executionId: failedState.id,
        projectId: 'ws-1',
        worktreeId: 'wt-1',
      },
      { portalCommandId: 'cmd-burst' },
    );
    await flushPromises();
    expect(runtime?.onPipelineStepOutput).toEqual(expect.any(Function));
    expect(runtime?.onPipelineEvent).toEqual(expect.any(Function));

    for (let index = 0; index < 100; index += 1) {
      runtime?.onPipelineStepOutput?.({
        executionId: failedState.id,
        jobId: 'job-1',
        jobName: 'Build',
        stepId: 'step-1',
        stepName: 'Test',
        attempt: 0,
        iteration: 1,
        stream: 'stdout',
        data: `line ${index}\n`,
      });
    }
    await waitForCondition(
      () => mockedLoadExecutionState.mock.calls.length === 2,
      'first burst output projection',
    );
    runtime?.onPipelineEvent?.({
      executionId: terminalState.id,
      type: 'execution.completed',
      state: terminalState,
      timestamp: '2026-05-06T00:00:02.000Z',
    });

    firstOutputProjection.resolve(runningState);
    await waitForCondition(
      () =>
        updates.some((event) => {
          if (event.type !== 'portal.pipeline.event') return false;
          const payload = event.payload;
          if (!isRecord(payload) || !isRecord(payload.entity)) return false;
          const run = payload.entity.payload;
          return isRecord(run) && run.status === 'success';
        }),
      'terminal update after output burst',
    );
    expect(mockedLoadExecutionState).toHaveBeenCalledTimes(2);

    mockedLoadExecutionState.mockResolvedValue(terminalState);
    finishRetry?.({
      requestId: '',
      ok: true,
      result: { execution: { id: failedState.id } },
    });
    await expect(retry).resolves.toMatchObject({ status: 'success' });
  });

  it('compacts pending output and ignores output after terminal state', async () => {
    const logFile = join(dir, 'terminal-stream.log');
    await writeFile(logFile, 'stream output', 'utf8');
    const failedState = {
      ...makeState(logFile),
      status: 'failure' as const,
    };
    const runningState = makeState(logFile);
    const terminalState = {
      ...makeState(logFile),
      status: 'success' as const,
      completed_at: '2026-05-06T00:00:02.000Z',
    };
    const firstOutputProjection = createDeferred<ExecutionState | null>();
    mockedLoadExecutionState
      .mockResolvedValueOnce(failedState)
      .mockImplementationOnce(() => firstOutputProjection.promise)
      .mockResolvedValue(runningState);
    let runtime: Parameters<typeof retryExecution>[1] | undefined;
    let finishRetry:
      | ((value: Awaited<ReturnType<typeof retryExecution>>) => void)
      | undefined;
    mockedRetryExecution.mockImplementation((_request, capturedRuntime) => {
      runtime = capturedRuntime;
      return new Promise((resolve) => {
        finishRetry = resolve;
      });
    });
    setCanopyPortalEventSink(() => undefined);

    const retry = retryPipeline({
      executionId: failedState.id,
      projectId: 'ws-1',
      worktreeId: 'wt-1',
    });
    await flushPromises();
    const firstEvent: StepOutputEvent = {
      executionId: failedState.id,
      jobId: 'job-1',
      jobName: 'Build',
      stepId: 'step-1',
      stepName: 'Test',
      attempt: 0,
      iteration: 1,
      stream: 'stdout',
      data: 'x'.repeat(2 * 1024 * 1024),
    };
    runtime?.onPipelineStepOutput?.(firstEvent);
    await waitForCondition(
      () => mockedLoadExecutionState.mock.calls.length === 2,
      'blocked output projection',
    );
    const pendingEvent: StepOutputEvent = {
      ...firstEvent,
      data: 'y'.repeat(2 * 1024 * 1024),
    };
    runtime?.onPipelineStepOutput?.(pendingEvent);
    pendingEvent.executionId = 'mutated-after-dispatch';
    firstOutputProjection.resolve(runningState);
    await waitForCondition(
      () => mockedLoadExecutionState.mock.calls.length === 3,
      'coalesced output projection',
    );
    expect(mockedLoadExecutionState.mock.calls[2]?.[0]).toBe(failedState.id);

    runtime?.onPipelineEvent?.({
      executionId: terminalState.id,
      type: 'execution.completed',
      state: terminalState,
      timestamp: '2026-05-06T00:00:02.000Z',
    });
    let lateDataReads = 0;
    const lateEvent: StepOutputEvent = {
      ...firstEvent,
      data: 'late output',
    };
    Object.defineProperty(lateEvent, 'data', {
      get() {
        lateDataReads += 1;
        return 'late output';
      },
    });
    runtime?.onPipelineStepOutput?.(lateEvent);
    expect(lateDataReads).toBe(0);

    mockedLoadExecutionState.mockResolvedValue(terminalState);
    finishRetry?.({
      requestId: '',
      ok: true,
      result: { execution: { id: failedState.id } },
    });
    await expect(retry).resolves.toMatchObject({ status: 'success' });
  });

  it('preserves coalesced live output tails from parallel steps', async () => {
    const logFile = join(dir, 'parallel-stream.log');
    await writeFile(logFile, '', 'utf8');
    const runningState = makeState(logFile);
    runningState.pipeline_snapshot.jobs['job-1'].steps.push({
      id: 'step-2',
      name: 'Package',
      shell: 'bash',
      continue_on_error: false,
      timeout_minutes: 0,
      skip_on_missing_action: false,
    });
    runningState.jobs['job-1'].steps['step-2'] = {
      status: 'running',
      outputs: {},
      dynamic_env: {},
      log_file: logFile,
    };
    const failedState = {
      ...runningState,
      status: 'failure' as const,
    };
    const terminalState = {
      ...runningState,
      status: 'success' as const,
      completed_at: '2026-05-06T00:00:02.000Z',
    };
    const firstOutputProjection = createDeferred<ExecutionState | null>();
    mockedLoadExecutionState
      .mockResolvedValueOnce(failedState)
      .mockImplementationOnce(() => firstOutputProjection.promise)
      .mockResolvedValue(runningState);
    let runtime: Parameters<typeof retryExecution>[1] | undefined;
    let finishRetry:
      | ((value: Awaited<ReturnType<typeof retryExecution>>) => void)
      | undefined;
    mockedRetryExecution.mockImplementation((_request, capturedRuntime) => {
      runtime = capturedRuntime;
      return new Promise((resolve) => {
        finishRetry = resolve;
      });
    });
    const updates: PortalEventEnvelope[] = [];
    setCanopyPortalEventSink((event) => updates.push(event));

    const retry = retryPipeline(
      {
        executionId: failedState.id,
        projectId: 'ws-1',
        worktreeId: 'wt-1',
      },
      { portalCommandId: 'cmd-parallel-output' },
    );
    await flushPromises();
    runtime?.onPipelineStepOutput?.({
      executionId: failedState.id,
      jobId: 'job-1',
      jobName: 'Build',
      stepId: 'step-1',
      stepName: 'Test',
      attempt: 0,
      iteration: 1,
      stream: 'stdout',
      data: 'compile output\n',
    });
    await waitForCondition(
      () => mockedLoadExecutionState.mock.calls.length === 2,
      'first parallel output projection',
    );
    runtime?.onPipelineStepOutput?.({
      executionId: failedState.id,
      jobId: 'job-1',
      jobName: 'Build',
      stepId: 'step-2',
      stepName: 'Package',
      attempt: 0,
      iteration: 1,
      stream: 'stdout',
      data: 'package output\n',
    });

    firstOutputProjection.resolve(runningState);
    await waitForCondition(
      () => mockedLoadExecutionState.mock.calls.length === 3,
      'coalesced parallel output projection',
    );
    await waitForCondition(
      () => updates.length >= 2,
      'parallel output updates',
    );
    const lastEvent = updates[updates.length - 1];
    const payload = lastEvent?.payload;
    const entity = isRecord(payload) ? payload.entity : undefined;
    const projectedRun = isRecord(entity) ? entity.payload : undefined;
    const jobs = isRecord(projectedRun) ? projectedRun.jobs : undefined;
    expect(jobs).toEqual([
      expect.objectContaining({
        steps: [
          expect.objectContaining({ outputTail: 'compile output\n' }),
          expect.objectContaining({ outputTail: 'package output\n' }),
        ],
      }),
    ]);

    mockedLoadExecutionState.mockResolvedValue(terminalState);
    finishRetry?.({
      requestId: '',
      ok: true,
      result: { execution: { id: failedState.id } },
    });
    await expect(retry).resolves.toMatchObject({ status: 'success' });
  });

  it('bounds aggregate live output tails for high-cardinality pipelines', async () => {
    const logFile = join(dir, 'many-step-stream.log');
    await writeFile(logFile, '', 'utf8');
    const runningState = makeState(logFile);
    const stepCount = 520;
    runningState.pipeline_snapshot.jobs['job-1'].steps = Array.from(
      { length: stepCount },
      (_, index) => ({
        id: `step-${index}`,
        name: `Step ${index}`,
        shell: 'bash',
        continue_on_error: false,
        timeout_minutes: 0,
        skip_on_missing_action: false,
      }),
    );
    runningState.jobs['job-1'].steps = Object.fromEntries(
      Array.from({ length: stepCount }, (_, index) => [
        `step-${index}`,
        {
          status: 'running' as const,
          outputs: {},
          dynamic_env: {},
          log_file: logFile,
        },
      ]),
    );
    const failedState = {
      ...runningState,
      status: 'failure' as const,
    };
    const terminalState = {
      ...runningState,
      status: 'success' as const,
      completed_at: '2026-05-06T00:00:02.000Z',
    };
    const firstOutputProjection = createDeferred<ExecutionState | null>();
    mockedLoadExecutionState
      .mockResolvedValueOnce(failedState)
      .mockImplementationOnce(() => firstOutputProjection.promise)
      .mockResolvedValue(runningState);
    let runtime: Parameters<typeof retryExecution>[1] | undefined;
    let finishRetry:
      | ((value: Awaited<ReturnType<typeof retryExecution>>) => void)
      | undefined;
    mockedRetryExecution.mockImplementation((_request, capturedRuntime) => {
      runtime = capturedRuntime;
      return new Promise((resolve) => {
        finishRetry = resolve;
      });
    });
    const updates: PortalEventEnvelope[] = [];
    setCanopyPortalEventSink((event) => updates.push(event));

    const retry = retryPipeline(
      {
        executionId: failedState.id,
        projectId: 'ws-1',
        worktreeId: 'wt-1',
      },
      { portalCommandId: 'cmd-many-step-output' },
    );
    await flushPromises();
    runtime?.onPipelineStepOutput?.({
      executionId: failedState.id,
      jobId: 'job-1',
      jobName: 'Build',
      stepId: 'step-0',
      stepName: 'Step 0',
      attempt: 0,
      iteration: 1,
      stream: 'stdout',
      data: 'seed',
    });
    await waitForCondition(
      () => mockedLoadExecutionState.mock.calls.length === 2,
      'first many-step output projection',
    );
    for (let index = 1; index < 300; index += 1) {
      runtime?.onPipelineStepOutput?.({
        executionId: failedState.id,
        jobId: 'job-1',
        jobName: 'Build',
        stepId: `step-${index}`,
        stepName: `Step ${index}`,
        attempt: 0,
        iteration: 1,
        stream: 'stdout',
        data: '',
      });
    }
    runtime?.onPipelineStepOutput?.({
      executionId: failedState.id,
      jobId: 'job-1',
      jobName: 'Build',
      stepId: 'step-0',
      stepName: 'Step 0',
      attempt: 0,
      iteration: 1,
      stream: 'stdout',
      data: 'revisited',
    });

    firstOutputProjection.resolve(runningState);
    await waitForCondition(
      () => mockedLoadExecutionState.mock.calls.length === 3,
      'coalesced many-step output projection',
    );
    await waitForCondition(
      () => updates.length >= 2,
      'bounded many-step output updates',
    );
    const tinyEntryEvent = updates[updates.length - 1];
    const tinyPayload = tinyEntryEvent?.payload;
    const tinyEntity = isRecord(tinyPayload) ? tinyPayload.entity : undefined;
    const tinyRun = isRecord(tinyEntity) ? tinyEntity.payload : undefined;
    const tinyJobs = isRecord(tinyRun) ? tinyRun.jobs : undefined;
    expect(
      (
        tinyJobs as Array<{
          steps?: Array<{ stepId?: string; outputTail?: string }>;
        }>
      )
        .flatMap((job) => job.steps ?? [])
        .find((step) => step.stepId === 'step-0')?.outputTail,
    ).toBe('revisited');

    const secondOutputProjection = createDeferred<ExecutionState | null>();
    mockedLoadExecutionState.mockImplementationOnce(
      () => secondOutputProjection.promise,
    );
    for (let index = 0; index < stepCount; index += 1) {
      runtime?.onPipelineStepOutput?.({
        executionId: failedState.id,
        jobId: 'job-1',
        jobName: 'Build',
        stepId: `step-${index}`,
        stepName: `Step ${index}`,
        attempt: 0,
        iteration: 1,
        stream: 'stdout',
        data: `${String(index).padStart(4, '0')}${'x'.repeat(2044)}`,
      });
      if (index === 0) {
        await waitForCondition(
          () => mockedLoadExecutionState.mock.calls.length === 4,
          'second blocked many-step output projection',
        );
      }
    }
    secondOutputProjection.resolve(runningState);
    await waitForCondition(
      () => mockedLoadExecutionState.mock.calls.length === 5,
      'second coalesced many-step output projection',
    );
    await waitForCondition(
      () => updates.length >= 4,
      'byte-bounded many-step output update',
    );
    const lastEvent = updates[updates.length - 1];
    const payload = lastEvent?.payload;
    const entity = isRecord(payload) ? payload.entity : undefined;
    const projectedRun = isRecord(entity) ? entity.payload : undefined;
    const jobs = isRecord(projectedRun) ? projectedRun.jobs : undefined;
    expect(portalEventByteLength(lastEvent)).toBeLessThanOrEqual(
      PORTAL_EVENT_BATCH_MAX_BYTES,
    );
    expect(JSON.stringify(jobs)).toContain(
      '[Earlier live step output omitted to fit the transfer limit]',
    );
    expect(JSON.stringify(jobs)).toContain('0519');

    mockedLoadExecutionState.mockResolvedValue(terminalState);
    finishRetry?.({
      requestId: '',
      ok: true,
      result: { execution: { id: failedState.id } },
    });
    await expect(retry).resolves.toMatchObject({ status: 'success' });
  });

  it('includes retained map keys and identifiers in the live-tail byte budget', async () => {
    const logFile = join(dir, 'identifier-heavy-stream.log');
    await writeFile(logFile, '', 'utf8');
    const runningState = makeState(logFile);
    runningState.id = `exec-${'e'.repeat(32 * 1024)}`;
    runningState.pipeline_snapshot.jobs['job-1'].steps = Array.from(
      { length: 6 },
      (_, index) => ({
        id: `step-${index}`,
        name: `Step ${index}`,
        shell: 'bash',
        continue_on_error: false,
        timeout_minutes: 0,
        skip_on_missing_action: false,
      }),
    );
    runningState.jobs['job-1'].steps = Object.fromEntries(
      Array.from({ length: 6 }, (_, index) => [
        `step-${index}`,
        {
          status: 'running' as const,
          outputs: {},
          dynamic_env: {},
          log_file: logFile,
        },
      ]),
    );
    const failedState = { ...runningState, status: 'failure' as const };
    const terminalState = {
      ...runningState,
      status: 'success' as const,
      completed_at: '2026-05-06T00:00:02.000Z',
    };
    const firstOutputProjection = createDeferred<ExecutionState | null>();
    mockedLoadExecutionState
      .mockResolvedValueOnce(failedState)
      .mockImplementationOnce(() => firstOutputProjection.promise)
      .mockResolvedValue(runningState);
    let runtime: Parameters<typeof retryExecution>[1] | undefined;
    let finishRetry:
      | ((value: Awaited<ReturnType<typeof retryExecution>>) => void)
      | undefined;
    mockedRetryExecution.mockImplementation((_request, capturedRuntime) => {
      runtime = capturedRuntime;
      return new Promise((resolve) => {
        finishRetry = resolve;
      });
    });
    const updates: PortalEventEnvelope[] = [];
    setCanopyPortalEventSink((event) => updates.push(event));

    const retry = retryPipeline({
      executionId: failedState.id,
      projectId: 'ws-1',
      worktreeId: 'wt-1',
    });
    await flushPromises();
    for (let index = 0; index < 6; index += 1) {
      runtime?.onPipelineStepOutput?.({
        executionId: failedState.id,
        jobId: 'job-1',
        jobName: 'Build',
        stepId: `step-${index}`,
        stepName: `Step ${index}`,
        attempt: 0,
        iteration: 1,
        stream: 'stdout',
        data: `output-${index}`,
      });
      if (index === 0) {
        await waitForCondition(
          () => mockedLoadExecutionState.mock.calls.length === 2,
          'blocked identifier-heavy output projection',
        );
      }
    }
    firstOutputProjection.resolve(runningState);
    await waitForCondition(
      () => mockedLoadExecutionState.mock.calls.length === 3,
      'coalesced identifier-heavy output projection',
    );
    await waitForCondition(
      () => updates.length >= 2,
      'identifier-bounded output update',
    );
    const payload = updates[updates.length - 1]?.payload;
    const entity = isRecord(payload) ? payload.entity : undefined;
    const run = isRecord(entity) ? entity.payload : undefined;
    const jobs = isRecord(run) ? run.jobs : undefined;
    const steps = (
      jobs as Array<{ steps?: Array<{ stepId?: string; outputTail?: string }> }>
    ).flatMap((job) => job.steps ?? []);
    expect(steps.find((step) => step.stepId === 'step-0')?.outputTail).toBe(
      undefined,
    );
    expect(steps.find((step) => step.stepId === 'step-5')?.outputTail).toBe(
      'output-5',
    );

    mockedLoadExecutionState.mockResolvedValue(terminalState);
    finishRetry?.({
      requestId: '',
      ok: true,
      result: { execution: { id: failedState.id } },
    });
    await expect(retry).resolves.toMatchObject({ status: 'success' });
  });

  it('serializes asynchronous run projections before emitting portal updates', async () => {
    const slowLog = join(dir, 'slow-stream.log');
    const fastLog = join(dir, 'fast-stream.log');
    await writeFile(slowLog, 'slow', 'utf8');
    await writeFile(fastLog, 'fast', 'utf8');
    const failedState = {
      ...makeState(fastLog),
      status: 'failure' as const,
    };
    const runningState = makeState(slowLog);
    const terminalState = {
      ...makeState(fastLog),
      status: 'success' as const,
      completed_at: '2026-05-06T00:00:02.000Z',
    };
    let resolveSlowOpen:
      | ((handle: Awaited<ReturnType<typeof actualFsPromises.open>>) => void)
      | undefined;
    const slowOpen = new Promise<
      Awaited<ReturnType<typeof actualFsPromises.open>>
    >((resolve) => {
      resolveSlowOpen = resolve;
    });
    mockedOpenFile.mockImplementation((path, flags, mode) =>
      String(path) === slowLog
        ? slowOpen
        : actualFsPromises.open(path, flags, mode),
    );
    mockedLoadExecutionState
      .mockResolvedValueOnce(failedState)
      .mockResolvedValue(terminalState);
    let runtime: Parameters<typeof retryExecution>[1] | undefined;
    let finishRetry:
      | ((value: Awaited<ReturnType<typeof retryExecution>>) => void)
      | undefined;
    mockedRetryExecution.mockImplementation((_request, capturedRuntime) => {
      runtime = capturedRuntime;
      return new Promise((resolve) => {
        finishRetry = resolve;
      });
    });
    const updates: PortalEventEnvelope[] = [];
    setCanopyPortalEventSink((event) => updates.push(event));

    const retry = retryPipeline(
      {
        executionId: failedState.id,
        projectId: 'ws-1',
        worktreeId: 'wt-1',
      },
      { portalCommandId: 'cmd-1' },
    );
    await flushPromises();
    expect(runtime?.onPipelineEvent).toEqual(expect.any(Function));

    runtime?.onPipelineEvent?.({
      executionId: failedState.id,
      type: 'execution.started',
      state: runningState,
      timestamp: '2026-05-06T00:00:01.000Z',
    });
    runtime?.onPipelineEvent?.({
      executionId: terminalState.id,
      type: 'execution.completed',
      state: terminalState,
      timestamp: '2026-05-06T00:00:02.000Z',
    });
    for (let index = 0; index < 20 && updates.length === 0; index += 1) {
      await flushPromises();
    }

    const projectedStatuses = (): string[] =>
      updates.flatMap((event) => {
        if (event.type !== 'portal.pipeline.event') return [];
        const payload = event.payload;
        if (!isRecord(payload) || !isRecord(payload.entity)) return [];
        const run = payload.entity.payload;
        return isRecord(run) && typeof run.status === 'string'
          ? [run.status]
          : [];
      });
    const statusesBeforeSlowProjection = projectedStatuses();

    resolveSlowOpen?.(await actualFsPromises.open(slowLog, 'r'));
    await waitForCondition(
      () => projectedStatuses().length >= 2,
      'serialized pipeline projections',
    );
    const statusesAfterSlowProjection = projectedStatuses();

    finishRetry?.({
      requestId: '',
      ok: true,
      result: { execution: { id: failedState.id } },
    });
    await expect(retry).resolves.toMatchObject({ status: 'success' });

    expect(statusesBeforeSlowProjection).toEqual([]);
    expect(statusesAfterSlowProjection).toEqual(['running', 'success']);
  });

  it('orders the final projection behind an earlier asynchronous event', async () => {
    const slowLog = join(dir, 'slow-final-race.log');
    const fastLog = join(dir, 'fast-final-race.log');
    await writeFile(slowLog, 'slow', 'utf8');
    await writeFile(fastLog, 'fast', 'utf8');
    const failedState = {
      ...makeState(fastLog),
      status: 'failure' as const,
    };
    const runningState = makeState(slowLog);
    const terminalState = {
      ...makeState(fastLog),
      status: 'success' as const,
      completed_at: '2026-05-06T00:00:02.000Z',
    };
    let resolveSlowOpen:
      | ((handle: Awaited<ReturnType<typeof actualFsPromises.open>>) => void)
      | undefined;
    const slowOpen = new Promise<
      Awaited<ReturnType<typeof actualFsPromises.open>>
    >((resolve) => {
      resolveSlowOpen = resolve;
    });
    mockedOpenFile.mockImplementation((path, flags, mode) =>
      String(path) === slowLog
        ? slowOpen
        : actualFsPromises.open(path, flags, mode),
    );
    mockedLoadExecutionState
      .mockResolvedValueOnce(failedState)
      .mockResolvedValue(terminalState);
    mockedRetryExecution.mockImplementation((_request, runtime) => {
      runtime.onPipelineEvent?.({
        executionId: failedState.id,
        type: 'execution.started',
        state: runningState,
        timestamp: '2026-05-06T00:00:01.000Z',
      });
      return Promise.resolve({
        requestId: '',
        ok: true,
        result: { execution: { id: failedState.id } },
      });
    });
    const updates: PortalEventEnvelope[] = [];
    setCanopyPortalEventSink((event) => updates.push(event));

    const retry = retryPipeline(
      {
        executionId: failedState.id,
        projectId: 'ws-1',
        worktreeId: 'wt-1',
      },
      { portalCommandId: 'cmd-final-race' },
    );
    for (let index = 0; index < 20 && updates.length === 0; index += 1) {
      await flushPromises();
    }

    const projectedStatuses = (): string[] =>
      updates.flatMap((event) => {
        if (event.type !== 'portal.pipeline.event') return [];
        const payload = event.payload;
        if (!isRecord(payload) || !isRecord(payload.entity)) return [];
        const run = payload.entity.payload;
        return isRecord(run) && typeof run.status === 'string'
          ? [run.status]
          : [];
      });
    expect(projectedStatuses()).toEqual([]);

    resolveSlowOpen?.(await actualFsPromises.open(slowLog, 'r'));
    await expect(retry).resolves.toMatchObject({ status: 'success' });
    await waitForCondition(
      () => projectedStatuses().length >= 2,
      'final pipeline projection ordering',
    );
    expect(projectedStatuses()).toEqual(['running', 'success']);
  });
});

describe('ambient portal run observers', () => {
  afterEach(() => {
    setCanopyPortalEventSink(null);
  });

  function runUpsertStatuses(events: PortalEventEnvelope[]): string[] {
    return events.flatMap((event) => {
      if (event.type !== 'portal.pipeline.event') return [];
      const payload = event.payload;
      if (!isRecord(payload) || !isRecord(payload.entity)) return [];
      if (payload.entity.entityType !== 'pipeline_run') return [];
      const run = payload.entity.payload;
      return isRecord(run) && typeof run.status === 'string'
        ? [run.status]
        : [];
    });
  }

  it('publishes a run upsert for an execution started outside the browser', async () => {
    const events: PortalEventEnvelope[] = [];
    setCanopyPortalEventSink((event) => events.push(event));

    const observers = createPipelineRunObservers('exec-desktop');
    expect(observers).not.toBeNull();
    observers?.onEvent({
      executionId: 'exec-desktop',
      type: 'execution.updated',
      state: { ...makeState('/tmp/step.log'), id: 'exec-desktop' },
      timestamp: '2026-05-06T00:00:01.000Z',
    });
    await waitForCondition(
      () => runUpsertStatuses(events).length > 0,
      'ambient pipeline run upsert',
    );

    expect(runUpsertStatuses(events)).toEqual(['running']);
  });

  it('stays silent while no browser session is attached', async () => {
    const events: PortalEventEnvelope[] = [];
    const observers = createPipelineRunObservers('exec-offline');
    observers?.onEvent({
      executionId: 'exec-offline',
      type: 'execution.updated',
      state: { ...makeState('/tmp/step.log'), id: 'exec-offline' },
      timestamp: '2026-05-06T00:00:01.000Z',
    });
    await flushPromises();

    expect(runUpsertStatuses(events)).toEqual([]);
  });
});

describe('pipeline run chat-turn links (CAN-3619)', () => {
  const mockedListExecutionSummaries = jest.mocked(listExecutionSummaries);

  afterEach(() => {
    setCanopyPortalEventSink(null);
    mockChatTabsByScope.clear();
    mockTranscriptsByChat.clear();
  });

  function linkState(
    executionId: string,
    worktreeId: string,
    overrides: Partial<ExecutionState> = {},
  ): ExecutionState {
    return {
      ...makeState('/tmp/canopy-links-missing.log'),
      id: executionId,
      worktree_id: worktreeId,
      ...overrides,
    };
  }

  function receipt(
    executionId: string,
    worktreeId: string,
    operation = 'pipeline.run',
  ): ReturnType<typeof buildPipelineRunArtifactReceipt> {
    return buildPipelineRunArtifactReceipt({
      operation,
      executionId,
      pipelineId: 'pipe-1',
      pipelineName: 'Pipeline',
      initialStatus: 'running',
      queuedAt: '2026-05-06T00:00:00.000Z',
      startedAt: '2026-05-06T00:00:00.000Z',
      createdAt: '2026-05-06T00:00:00.000Z',
      projectId: 'ws-1',
      worktreeId,
      navigationTarget: {
        kind: 'pipeline_execution',
        executionId,
        projectId: 'ws-1',
        worktreeId,
      },
    });
  }

  function user(id: string, hidden = false): PersistedChatMessage {
    return {
      id,
      role: 'user',
      blocks: [{ type: 'text', text: `ask ${id}` }],
      timestamp: 1,
      ...(hidden ? { hidden: true } : {}),
    };
  }

  function dispatchCall(id: string, toolUseId: string): PersistedChatMessage {
    return {
      id,
      role: 'assistant',
      blocks: [
        {
          type: 'tool_use',
          toolUseId,
          toolName: 'DispatchAction',
          input: '{}',
        },
      ],
      timestamp: 2,
    };
  }

  function dispatchResult(
    id: string,
    toolUseId: string,
    receipts: unknown[],
    padding = '',
  ): PersistedChatMessage {
    return {
      id,
      role: 'assistant',
      blocks: [
        {
          type: 'tool_result',
          toolUseId,
          toolName: 'DispatchAction',
          output: JSON.stringify({
            ok: true,
            result: {
              agentArtifacts: receipts,
              ...(padding ? { padding } : {}),
            },
          }),
          isError: false,
        },
      ],
      timestamp: 3,
    };
  }

  function chatTab(
    id: string,
    carry?: PersistedChatTab['agentArtifactCarryByTurn'],
  ): PersistedChatTab {
    return {
      id,
      title: id,
      messages: [],
      createdAt: '2026-05-06T00:00:00.000Z',
      ...(carry ? { agentArtifactCarryByTurn: carry } : {}),
    };
  }

  /**
   * One worktree whose chats link exec-1 through every attribution path the
   * desktop renderer recognizes, plus decoys that must not link.
   */
  function seedLinkedWorktree(worktreeId: string): void {
    const scope = `ws-1/${worktreeId}`;
    const fullExternalOutput = JSON.stringify({
      ok: true,
      result: {
        agentArtifacts: [receipt('exec-1', worktreeId)],
        padding: 'e'.repeat(80_000),
      },
    });
    mockChatTabsByScope.set(scope, [
      chatTab('chat-old'),
      chatTab('chat-late'),
      chatTab('chat-big'),
      chatTab('chat-ext'),
      chatTab('chat-watch', {
        'watch-2': [receipt('exec-1', worktreeId, 'pipeline.watch')],
      }),
      chatTab('chat-foreign'),
      chatTab('chat-error'),
    ]);
    // Launched from the oldest turn of a long, non-active chat; the same turn
    // later resumes it, which still yields one link for that turn.
    mockTranscriptsByChat.set('chat-old', [
      user('old-1'),
      dispatchCall('old-1-call', 'old-tool-1'),
      dispatchResult('old-1-result', 'old-tool-1', [
        receipt('exec-1', worktreeId),
      ]),
      dispatchCall('old-1-call-2', 'old-tool-2'),
      dispatchResult('old-1-result-2', 'old-tool-2', [
        receipt('exec-1', worktreeId, 'pipeline.execution_resume'),
      ]),
      ...Array.from({ length: 60 }, (_, index) => user(`old-filler-${index}`)),
    ]);
    // A late tool result lands after the next user message and still belongs
    // to the turn that made the call.
    mockTranscriptsByChat.set('chat-late', [
      user('late-1'),
      dispatchCall('late-1-call', 'late-tool'),
      user('late-2'),
      dispatchResult('late-2-result', 'late-tool', [
        receipt('exec-1', worktreeId, 'pipeline.execution_retry'),
      ]),
    ]);
    // Larger than the Portal chat text cap; links come from the canonical
    // transcript, never from truncated Portal text.
    mockTranscriptsByChat.set('chat-big', [
      user('big-1'),
      dispatchCall('big-1-call', 'big-tool'),
      dispatchResult(
        'big-1-result',
        'big-tool',
        [receipt('exec-1', worktreeId)],
        'b'.repeat(6_000),
      ),
    ]);
    // Externalized dispatch output keeps only its persisted preview, which
    // the desktop renderer cannot parse either, so it links nothing.
    mockTranscriptsByChat.set('chat-ext', [
      user('ext-1'),
      dispatchCall('ext-1-call', 'ext-tool'),
      {
        id: 'ext-1-result',
        role: 'assistant',
        blocks: [
          {
            type: 'tool_result',
            toolUseId: 'ext-tool',
            toolName: 'DispatchAction',
            output: `${fullExternalOutput.slice(0, 1_000)}\n[truncated]`,
            isError: false,
            outputTruncated: true,
            fullOutputRef: {
              version: 1,
              artifactId: `artifact-${worktreeId}`,
              byteLength: Buffer.byteLength(fullExternalOutput, 'utf8'),
              sha256: 'sha',
              encoding: 'utf-8',
              mediaType: 'text/plain',
            },
          },
        ],
        timestamp: 3,
      },
    ]);
    // Watched run carried into the second turn only.
    mockTranscriptsByChat.set('chat-watch', [
      user('watch-1'),
      user('watch-2'),
      user('watch-3'),
    ]);
    // Decoys: another worktree's receipt, and an errored dispatch.
    mockTranscriptsByChat.set('chat-foreign', [
      user('foreign-1'),
      dispatchCall('foreign-1-call', 'foreign-tool'),
      dispatchResult('foreign-1-result', 'foreign-tool', [
        receipt('exec-1', 'wt-elsewhere'),
      ]),
    ]);
    mockTranscriptsByChat.set('chat-error', [
      user('error-1'),
      dispatchCall('error-1-call', 'error-tool'),
      {
        ...dispatchResult('error-1-result', 'error-tool', [
          receipt('exec-1', worktreeId),
        ]),
        blocks: [
          {
            type: 'tool_result',
            toolUseId: 'error-tool',
            toolName: 'DispatchAction',
            output: JSON.stringify({
              ok: true,
              result: { agentArtifacts: [receipt('exec-1', worktreeId)] },
            }),
            isError: true,
          },
        ],
      },
    ]);
  }

  const expectedLinks = [
    { chatId: 'chat-old', userMessageId: 'old-1', relation: 'launched' },
    { chatId: 'chat-late', userMessageId: 'late-1', relation: 'launched' },
    { chatId: 'chat-big', userMessageId: 'big-1', relation: 'launched' },
    { chatId: 'chat-watch', userMessageId: 'watch-2', relation: 'watching' },
  ];

  function runPayloads(
    events: PortalEventEnvelope[],
  ): Array<Record<string, unknown>> {
    return events.flatMap((event) => {
      if (event.type !== 'portal.pipeline.event') return [];
      const payload = event.payload;
      if (!isRecord(payload) || !isRecord(payload.entity)) return [];
      const run = payload.entity.payload;
      return isRecord(run) ? [run] : [];
    });
  }

  it('attributes snapshot rows to the chat turns desktop shows them under', async () => {
    seedLinkedWorktree('wt-links-snapshot');
    mockedListExecutionSummaries.mockResolvedValue([
      {
        id: 'exec-1',
        pipeline_id: 'pipe-1',
        pipeline_name: 'Pipeline',
        status: 'running',
        started_at: '2026-05-06T00:00:00.000Z',
        project_id: 'ws-1',
        worktree_id: 'wt-links-snapshot',
      },
      {
        id: 'exec-unlinked',
        pipeline_id: 'pipe-1',
        pipeline_name: 'Pipeline',
        status: 'running',
        started_at: '2026-05-06T00:00:00.000Z',
        project_id: 'ws-1',
        worktree_id: 'wt-links-snapshot',
      },
      {
        id: 'exec-stateless',
        pipeline_id: 'pipe-1',
        pipeline_name: 'Pipeline',
        status: 'success',
        started_at: '2026-05-06T00:00:00.000Z',
        project_id: 'ws-1',
        worktree_id: 'wt-links-snapshot',
      },
    ] as Awaited<ReturnType<typeof listExecutionSummaries>>);
    mockTranscriptsByChat.set('chat-big', [
      ...(mockTranscriptsByChat.get('chat-big') ?? []),
      dispatchCall('big-2-call', 'big-tool-2'),
      dispatchResult('big-2-result', 'big-tool-2', [
        receipt('exec-stateless', 'wt-links-snapshot'),
      ]),
    ]);
    mockedLoadExecutionState.mockImplementation((executionId: string) =>
      executionId === 'exec-stateless'
        ? Promise.reject(new Error('missing'))
        : Promise.resolve(linkState(executionId, 'wt-links-snapshot')),
    );

    const runs = await listPipelineRuns({
      workspaceLocalId: 'ws-1',
      worktreeLocalId: 'wt-links-snapshot',
    });

    expect(runs.find((run) => run.localId === 'exec-1')).toMatchObject({
      chatTurns: expectedLinks,
    });
    // Unlinked runs carry an explicit empty list so clients can clear links.
    expect(runs.find((run) => run.localId === 'exec-unlinked')).toMatchObject({
      chatTurns: [],
    });
    expect(runs.find((run) => run.localId === 'exec-stateless')).toMatchObject({
      chatTurns: [
        { chatId: 'chat-big', userMessageId: 'big-1', relation: 'launched' },
      ],
    });
  });

  it('carries links on execution.get and its feature upsert', async () => {
    seedLinkedWorktree('wt-links-get');
    mockedLoadExecutionState.mockResolvedValue(
      linkState('exec-1', 'wt-links-get'),
    );
    const events: PortalEventEnvelope[] = [];
    setCanopyPortalEventSink((event) => events.push(event));

    const run = await getPipelineExecution({
      executionId: 'exec-1',
      projectId: 'ws-1',
      worktreeId: 'wt-links-get',
    });

    expect(run).toMatchObject({ chatTurns: expectedLinks });
    expect(runPayloads(events)).toEqual([
      expect.objectContaining({ chatTurns: expectedLinks }),
    ]);
  });

  it('keeps links and run identity in the oversized event fallback', async () => {
    seedLinkedWorktree('wt-links-oversized');
    const oversized = linkState('exec-1', 'wt-links-oversized', {
      parent_execution_id: 'exec-parent',
    });
    oversized.pipeline_snapshot.jobs['job-1'].steps = Array.from(
      { length: 300 },
      (_, index) => ({
        id: `step-${index}`,
        name: `Step ${index} ${'x'.repeat(4096)}`,
        shell: 'bash',
        continue_on_error: false,
        timeout_minutes: 0,
        skip_on_missing_action: false,
      }),
    );
    oversized.jobs['job-1'].steps = {};
    mockedLoadExecutionState.mockResolvedValue(oversized);
    const events: PortalEventEnvelope[] = [];
    setCanopyPortalEventSink((event) => events.push(event));

    await getPipelineExecution({
      executionId: 'exec-1',
      projectId: 'ws-1',
      worktreeId: 'wt-links-oversized',
    });

    expect(runPayloads(events)).toEqual([
      expect.objectContaining({
        localId: 'exec-1',
        runId: 'exec-1',
        pipelineName: 'Pipeline',
        parentExecutionId: 'exec-parent',
        truncated: true,
        chatTurns: expectedLinks,
      }),
    ]);
  });

  it('omits links while a chat transcript has never been read', async () => {
    const worktreeId = 'wt-links-unread';
    mockChatTabsByScope.set(`ws-1/${worktreeId}`, [chatTab('chat-a')]);
    mockTranscriptsByChat.set('chat-a', [
      user('a-1'),
      dispatchCall('a-1-call', 'a-tool'),
      dispatchResult('a-1-result', 'a-tool', [receipt('exec-1', worktreeId)]),
    ]);
    mockChatStateService.consumeTranscript.mockImplementationOnce(() =>
      Promise.reject(new Error('recovery_error')),
    );
    mockedLoadExecutionState.mockResolvedValue(linkState('exec-1', worktreeId));
    const events: PortalEventEnvelope[] = [];
    setCanopyPortalEventSink((event) => events.push(event));

    const run = await getPipelineExecution({
      executionId: 'exec-1',
      projectId: 'ws-1',
      worktreeId,
    });

    // Absent means "keep": an explicit empty list would clear held links.
    expect(run).not.toHaveProperty('chatTurns');
    expect(runPayloads(events)).toHaveLength(1);
    expect(runPayloads(events)[0]).not.toHaveProperty('chatTurns');

    // The next lookup reads the chat and publishes the links.
    await expect(
      getPipelineExecution({
        executionId: 'exec-1',
        projectId: 'ws-1',
        worktreeId,
      }),
    ).resolves.toMatchObject({
      chatTurns: [
        { chatId: 'chat-a', userMessageId: 'a-1', relation: 'launched' },
      ],
    });
  });

  it('publishes link changes after durable chat commits, including removals', async () => {
    const worktreeId = 'wt-links-commit';
    mockChatTabsByScope.set(`ws-1/${worktreeId}`, [chatTab('chat-a')]);
    mockTranscriptsByChat.set('chat-a', [user('a-1')]);
    mockedLoadExecutionState.mockResolvedValue(linkState('exec-1', worktreeId));
    const events: PortalEventEnvelope[] = [];
    setCanopyPortalEventSink((event) => events.push(event));
    const materialize = (
      tabs: PersistedChatTab[],
      changedTabIds: string[],
      removedTabIds: string[] = [],
    ): void => {
      void projectChatTabsMaterialization(
        () => null,
        'ws-1',
        worktreeId,
        { version: 1, tabs, activeTabId: tabs[0]?.id ?? '' },
        { changedTabIds, removedTabIds },
      ).catch(() => undefined);
    };

    await getPipelineExecution({
      executionId: 'exec-1',
      projectId: 'ws-1',
      worktreeId,
    });
    expect(runPayloads(events)).toEqual([
      expect.objectContaining({ localId: 'exec-1', chatTurns: [] }),
    ]);

    // A launch receipt committed to chat-a republishes the unchanged run.
    mockTranscriptsByChat.set('chat-a', [
      user('a-1'),
      dispatchCall('a-1-call', 'a-tool'),
      dispatchResult('a-1-result', 'a-tool', [receipt('exec-1', worktreeId)]),
    ]);
    materialize([chatTab('chat-a')], ['chat-a']);
    await waitForCondition(
      () => runPayloads(events).length >= 2,
      'link upsert after commit',
    );
    expect(runPayloads(events)[1]).toMatchObject({
      localId: 'exec-1',
      chatTurns: [
        { chatId: 'chat-a', userMessageId: 'a-1', relation: 'launched' },
      ],
    });

    // A commit that leaves links unchanged publishes nothing.
    mockTranscriptsByChat.set('chat-a', [
      ...(mockTranscriptsByChat.get('chat-a') ?? []),
      {
        id: 'a-1-text',
        role: 'assistant',
        blocks: [{ type: 'text', text: 'Started it.' }],
        timestamp: 4,
      },
    ]);
    materialize([chatTab('chat-a')], ['chat-a']);
    await new Promise((resolve) => setTimeout(resolve, 1_300));
    expect(runPayloads(events)).toHaveLength(2);

    // Closing the chat clears its links with an explicit empty list.
    mockChatTabsByScope.set(`ws-1/${worktreeId}`, []);
    mockTranscriptsByChat.delete('chat-a');
    materialize([], [], ['chat-a']);
    await waitForCondition(
      () => runPayloads(events).length >= 3,
      'link removal upsert after commit',
    );
    expect(runPayloads(events)[2]).toMatchObject({
      localId: 'exec-1',
      chatTurns: [],
    });
  });
});

describe('pipeline run chat follow-up availability (CAN-3719)', () => {
  function followUpState(overrides: Partial<ExecutionState>): ExecutionState {
    return {
      ...makeState('/tmp/canopy-follow-up-missing.log'),
      status: 'failure',
      ...overrides,
    };
  }

  it('projects saved plan and report availability without exposing paths', async () => {
    const run = await stateToPortalRun(
      followUpState({
        event_data: { task_ready: { task_path: '/t.md', plan_path: '/p.md' } },
        report_outputs: { report_json_file: '/exec/report.json' },
      }),
    );
    expect(run).toMatchObject({
      status: 'failed',
      chatFollowUp: { planAvailable: true, reportAvailable: true },
    });
    expect(JSON.stringify(run)).not.toContain('/p.md');
    expect(JSON.stringify(run)).not.toContain('/exec/report.json');
  });

  it('reports no saved output explicitly, even for a successful run', async () => {
    const run = await stateToPortalRun(
      followUpState({ status: 'success', report_outputs: {} }),
    );
    expect(run).toMatchObject({
      chatFollowUp: { planAvailable: false, reportAvailable: false },
    });
  });

  describe('preparePipelineChatFollowUp', () => {
    beforeEach(() => {
      mockedReadAllSidebarItems.mockResolvedValue({
        items: [
          { id: 'ws-1', type: 'single-repo', worktrees: [{ id: 'wt-1' }] },
        ],
      } as Awaited<ReturnType<typeof readAllSidebarItems>>);
    });

    const request = {
      executionId: 'exec-1',
      projectId: 'ws-1',
      worktreeId: 'wt-1',
    };

    it.each([
      [
        'plan_ready before task_ready',
        {
          event_data: {
            plan_ready: { plan_path: '/plans/ready.md' },
            task_ready: { task_path: '/t.md', plan_path: '/plans/task.md' },
          },
        },
        'plan' as const,
        'Review this plan: /plans/ready.md',
      ],
      [
        'task_ready plan path',
        {
          event_data: {
            task_ready: { task_path: '/t.md', plan_path: '/plans/task.md' },
          },
        },
        'plan' as const,
        'Review this plan: /plans/task.md',
      ],
      [
        'report_file before report_json_file',
        {
          report_outputs: {
            report_file: '/exec/report.md',
            report_json_file: '/exec/report.json',
          },
        },
        'report' as const,
        'Review this report: /exec/report.md',
      ],
      [
        'report_json_file',
        { report_outputs: { report_json_file: '/exec/report.json' } },
        'report' as const,
        'Review this report: /exec/report.json',
      ],
    ])(
      'uses %s, as the desktop action does',
      async (_name, overrides, output, prompt) => {
        mockedLoadExecutionState.mockResolvedValue(followUpState(overrides));
        await expect(
          preparePipelineChatFollowUp({ ...request, output }),
        ).resolves.toEqual({ prompt });
      },
    );

    it('rejects a run owned by another worktree', async () => {
      mockedLoadExecutionState.mockResolvedValue(
        followUpState({
          worktree_id: 'wt-2',
          report_outputs: { report_file: '/exec/report.md' },
        }),
      );
      await expect(
        preparePipelineChatFollowUp({ ...request, output: 'report' }),
      ).rejects.toMatchObject({ code: 'not_found' });
    });

    it('rejects a missing saved output with a readable reason', async () => {
      mockedLoadExecutionState.mockResolvedValue(
        followUpState({ report_outputs: { report_file: '/exec/report.md' } }),
      );
      await expect(
        preparePipelineChatFollowUp({ ...request, output: 'plan' }),
      ).rejects.toMatchObject({
        code: 'not_found',
        message: 'This workflow run does not have a saved plan file.',
      });
    });

    it('rejects a run whose owner worktree no longer exists', async () => {
      mockedReadAllSidebarItems.mockResolvedValue({
        version: 1,
        items: [
          {
            id: 'ws-1',
            name: 'Workspace',
            type: 'single-repo',
            repoPath: '/repo',
            color: '',
            worktrees: [],
            collapsed: false,
            order: 0,
          },
        ],
      });
      mockedLoadExecutionState.mockResolvedValue(
        followUpState({ report_outputs: { report_file: '/exec/report.md' } }),
      );
      await expect(
        preparePipelineChatFollowUp({ ...request, output: 'report' }),
      ).rejects.toMatchObject({
        code: 'not_found',
        message: "This run's worktree is no longer available.",
      });
    });
  });
});

describe('readPipelineContent (CAN-3717)', () => {
  const executionsDir = '/tmp/canopy-test-data/pipeline-executions';
  let dir: string;
  const request = {
    executionId: 'exec-1',
    projectId: 'ws-1',
    worktreeId: 'wt-1',
  };
  const stepSource = {
    kind: 'step_output' as const,
    jobId: 'job-1',
    stepId: 'step-1',
  };

  beforeEach(async () => {
    await mkdir(executionsDir, { recursive: true });
    dir = await mkdtemp(join(executionsDir, 'canopy-pipeline-content-'));
  });

  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  function agentState(logFile: string, transcriptFile: string): ExecutionState {
    const state = makeState(logFile);
    const step = state.jobs['job-1']?.steps['step-1'];
    if (!step) throw new Error('fixture step missing');
    step.log_format_hint = 'agent';
    step.agent_provider = 'claude';
    step.outputs = { transcript_file: transcriptFile };
    return state;
  }

  it('reads an agent step as its readable assistant text, not provider JSON', async () => {
    const log = join(dir, 'step.log');
    const transcript = join(dir, 'transcript.jsonl');
    await writeFile(log, '{"type":"system","subtype":"init"}\n');
    await writeFile(
      transcript,
      `${JSON.stringify({
        type: 'assistant',
        uuid: 'a-1',
        message: {
          id: 'm-1',
          role: 'assistant',
          content: [{ type: 'text', text: '# Summary\n\nAll green.' }],
        },
      })}\n`,
    );
    mockedLoadExecutionState.mockResolvedValue(agentState(log, transcript));

    await expect(
      readPipelineContent({ ...request, source: stepSource }),
    ).resolves.toMatchObject({
      format: 'markdown',
      content: '# Summary\n\nAll green.',
      offset: 0,
      nextOffset: 21,
      length: 21,
    });
  });

  it('keeps a command step log as plain text, beyond the streamed tail', async () => {
    const log = join(dir, 'step.log');
    const output = `first line\n${'x'.repeat(10_000)}\nlast line\n`;
    await writeFile(log, output);
    mockedLoadExecutionState.mockResolvedValue(makeState(log));

    const page = await readPipelineContent({ ...request, source: stepSource });
    expect(page).toMatchObject({ format: 'text', content: output });
  });

  it('reads the saved report as the desktop shows it', async () => {
    const report = join(dir, 'report.md');
    const json = join(dir, 'report.json');
    await writeFile(report, '# Report');
    await writeFile(json, '{"ok":true}');
    mockedLoadExecutionState.mockResolvedValue({
      ...makeState(join(dir, 'step.log')),
      report_outputs: { report_file: report, report_json_file: json },
    });

    await expect(
      readPipelineContent({ ...request, source: { kind: 'report' } }),
    ).resolves.toMatchObject({
      format: 'markdown',
      content: '# Report\n\n## JSON report\n\n```json\n{\n  "ok": true\n}\n```',
    });
  });

  it('reads an empty document for a run without a saved report', async () => {
    mockedLoadExecutionState.mockResolvedValue(
      makeState(join(dir, 'step.log')),
    );
    await expect(
      readPipelineContent({ ...request, source: { kind: 'report' } }),
    ).resolves.toMatchObject({ content: '', length: 0, nextOffset: 0 });
  });

  it('refuses a report file outside the executions directory', async () => {
    mockedLoadExecutionState.mockResolvedValue({
      ...makeState(join(dir, 'step.log')),
      report_outputs: { report_file: '/etc/hosts' },
    });
    await expect(
      readPipelineContent({ ...request, source: { kind: 'report' } }),
    ).rejects.toMatchObject({ code: 'not_found' });
  });

  it('refuses a later page once the document changed', async () => {
    const log = join(dir, 'step.log');
    await writeFile(log, 'one');
    mockedLoadExecutionState.mockResolvedValue(makeState(log));
    const first = await readPipelineContent({ ...request, source: stepSource });
    await writeFile(log, 'one two');

    await expect(
      readPipelineContent({
        ...request,
        source: stepSource,
        offset: first.nextOffset,
        revision: first.revision,
      }),
    ).rejects.toMatchObject({ code: 'execution_failed' });
  });

  it('rejects a run owned by another worktree', async () => {
    mockedLoadExecutionState.mockResolvedValue({
      ...makeState(join(dir, 'step.log')),
      worktree_id: 'wt-2',
    });
    await expect(
      readPipelineContent({ ...request, source: { kind: 'report' } }),
    ).rejects.toMatchObject({ code: 'not_found' });
  });
});
