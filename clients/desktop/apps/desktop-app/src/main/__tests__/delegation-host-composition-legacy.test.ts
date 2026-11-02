import type { DelegationParentContext } from '@canopy/desktop-shared/node/delegation/types';
import {
  mkdtemp,
  rm,
  readFile,
  writeFile,
  readdir,
  chmod,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import type {
  ChatTabsFile,
  ArchivedChatsFile,
  PersistedChatMessage,
  PersistedChatTab,
} from '@canopy/desktop-shared/types';
import type {
  AgentDelegationBrokerOptions,
  StoredDelegation,
} from '@canopy/desktop-shared/node/delegation/broker';
import type * as DelegationBrokerModule from '@canopy/desktop-shared/node/delegation/broker';
import {
  FileDelegationStorage,
  FileManagedDelegationMessageStorage,
} from '@canopy/desktop-shared/node/delegation/storage';
import type {
  AgentDelegationSnapshot,
  AgentDelegationTranscript,
  AgentDelegationTranscriptItem,
} from '@canopy/protocol/delegation';
import { routeFixture } from '@canopy/desktop-shared/node/delegation/__tests__/fixtures';
import type { DelegationReadMetadataSource } from '@canopy/desktop-shared/node/delegation/record-read-metadata';
import {
  decodeStoredDelegationV3,
  readMetadataOfRecord,
} from '@canopy/desktop-shared/node/delegation/record-v3';
import type {
  RepositoryDelegationTranscriptChatState,
  DelegationRecordReadPort,
} from '../agents/delegation/repository-transcript-port';
import type { ChatStateService } from '../services/chat-state-service';
import type { ChatReadSelection } from '../services/chat-state-v2-backend';
import { DelegationIoTrace } from './helpers/delegation-io-trace';

type WorktreeScope = { projectId: string; worktreeId: string };
type ChatScope = WorktreeScope & { chatId: string };
const FIXED_NOW = 1_798_000_000_000;
let mockDataRoot = '';
let mockTrace: DelegationIoTrace;
let mockRecords: StoredDelegation[] = [];
let mockRuns: AgentDelegationTranscript[] = [];
let mockRevisionAtBarrier = false;
let mockMixedPort: DelegationRecordReadPort | undefined;
const mockHostGetter = jest.fn();
const mockWatcherErrors: unknown[] = [];
const mockForbiddenRead = (method: string, args: unknown[]): Promise<never> =>
  mockTrace.call(`registry.${method}`, undefined, args, () =>
    Promise.reject(new Error(`Unexpected registry call: ${method}`)),
  );
const mockInitialize = jest.fn((): Promise<void> => Promise.resolve());
const mockGetCompatibilityTabs = jest.fn<
  Promise<ChatTabsFile>,
  [WorktreeScope, ChatReadSelection?]
>();
const mockGetCompatibilityArchives = jest.fn<
  Promise<ArchivedChatsFile>,
  [WorktreeScope, ChatReadSelection?]
>();
const mockReadDelegationItems = jest.fn(
  (): Promise<AgentDelegationTranscriptItem[]> => Promise.resolve([]),
);
const mockPortalRead = jest.fn<
  Promise<ChatTabsFile>,
  [string, string, ChatReadSelection?]
>();

jest.mock('@canopy/desktop-shared/node/delegation/broker', () => ({
  ...jest.requireActual<typeof DelegationBrokerModule>(
    '@canopy/desktop-shared/node/delegation/broker',
  ),
  AgentDelegationBroker: jest.fn((options: AgentDelegationBrokerOptions) => ({
    initialize: mockInitialize,
    parentCwd: (): string => options.cwd,
    // The service reports the worktree's lifetime allowance once the broker loads.
    lifetimeSnapshot: (): {
      kind: 'available';
      occupied: number;
      retained: number;
      limit: number;
      cap: number;
      atLimit: boolean;
      extension: 'at_cap';
    } => ({
      kind: 'available',
      occupied: 0,
      retained: 0,
      limit: 512,
      cap: 512,
      atLimit: false,
      extension: 'at_cap',
    }),
    replayQueuedBackground: mockInitialize,
    transcripts: (
      parent: DelegationParentContext,
      id?: string,
    ): Promise<readonly AgentDelegationTranscript[]> =>
      mockTrace.call('broker.transcripts', id, [parent, id], async () => {
        await mockTrace.call('broker.writeBarrier', undefined, [], () =>
          Promise.resolve(),
        );
        if (mockRevisionAtBarrier) {
          mockRevisionAtBarrier = false;
          mockRuns = mockRuns.map((run) => ({
            ...run,
            sequence: run.sequence + 1,
          }));
        }
        return mockRuns.filter(
          (run) => id === undefined || run.delegationId === id,
        );
      }),
    transcript: (
      parent: DelegationParentContext,
      key: string,
    ): Promise<AgentDelegationTranscript | undefined> =>
      mockTrace.call('broker.transcript', key, [parent, key], () =>
        Promise.resolve(mockRuns.find((run) => run.delegationId === key)),
      ),
    recordStore: (
      parent: DelegationParentContext,
      id: string,
    ): 'legacy' | 'stream' | undefined => {
      const record = mockRecords.find(
        (record) =>
          record.state.delegationId === id &&
          record.parent.chatId === parent.chatId,
      );
      return record ? (record.version === 3 ? 'stream' : 'legacy') : undefined;
    },
    inspect: (
      parent: DelegationParentContext,
      id: string,
    ): AgentDelegationSnapshot | undefined =>
      mockTrace.sync(
        'broker.inspect',
        id,
        [parent, id],
        () => mockRuns.find((run) => run.delegationId === id)?.snapshot,
      ),
    list: (parent: DelegationParentContext): AgentDelegationSnapshot[] =>
      mockTrace.sync('broker.list', undefined, [parent], () =>
        mockRuns.map((run) => run.snapshot),
      ),
    message: (
      parent: DelegationParentContext,
      request: unknown,
      messageOperationId?: string,
    ): Promise<{ ok: false; error: { code: 'not_found'; message: string } }> =>
      mockTrace.call(
        'broker.message',
        undefined,
        [parent, request, messageOperationId],
        () =>
          Promise.resolve({
            ok: false,
            error: {
              code: 'not_found',
              message: 'Broker-only delivery reached',
            },
          }),
      ),
    manage: (
      parent: DelegationParentContext,
      request: unknown,
    ): Promise<never> =>
      mockTrace.call('broker.manage', undefined, [parent, request], () =>
        Promise.reject(new Error('unexpected manage')),
      ),
    deliver: mockInitialize,
    activeCount: (): number => 0,
    queuedCount: (): number => 0,
    close: mockInitialize,
    closeOwner: mockInitialize,
    revokeHarness: mockInitialize,
    childContext: (): undefined => undefined,
    continuationCandidates: (): [] => [],
    delegationLineage: (): undefined => undefined,
  })),
}));
jest.mock('../lib/paths', () => ({
  getAppAdvisorWatchersFilePath: (): string =>
    path.join(mockDataRoot, 'watchers.json'),
  getDataDir: (): string => mockDataRoot,
  getPreferencesFilePath: (): string =>
    path.join(mockDataRoot, 'preferences.json'),
  getWorktreeAttachmentsDir: (): string =>
    path.join(mockDataRoot, 'attachments'),
  getWorktreeDataDir: (projectId: string, worktreeId: string): string =>
    path.join(mockDataRoot, projectId, worktreeId),
}));
// A slow watcher mutation records a chat-wait diagnostic; keep it from
// starting the real observability flush against the partial paths mock above.
jest.mock('../observability', () => ({
  getObservabilityService: (): object => ({
    recordSessionDiagnostic: jest.fn(),
  }),
}));

jest.mock('../lib/canopy-cloud-account-store', () => ({
  loadCanopyCloudAccount: (): Promise<null> => Promise.resolve(null),
  subscribeCanopyCloudAccountChanges: (): (() => void) => () => undefined,
}));

jest.mock('../portal/portal-event-bus', () => ({
  createPortalEvent: (): object => ({}),
  enqueuePortalEvent: (): void => undefined,
  isCanopyPortalActive: (): boolean => false,
}));

type HostDouble = RepositoryDelegationTranscriptChatState &
  Pick<DelegationRecordReadPort, 'readStoredParentMessage'> &
  Pick<ChatStateService, 'childStreamCompatibilityPage'>;

jest.mock('../services/chat-state-service', () => ({
  getChatStateService: (): HostDouble & Record<string, unknown> => {
    mockHostGetter();
    return {
      getCompatibilityTabs: mockGetCompatibilityTabs,
      getCompatibilityArchives: mockGetCompatibilityArchives,
      readDelegationItems: (
        ...args: unknown[]
      ): Promise<AgentDelegationTranscriptItem[]> =>
        mockTrace.call(
          'compatibility.readDelegationItems',
          undefined,
          args,
          () => mockReadDelegationItems(),
        ),
      appendDelegationReceipt: (...args: unknown[]): Promise<never> =>
        mockForbiddenRead('appendDelegationReceipt', args),
      itemAdmission: (...args: unknown[]): Promise<never> =>
        mockForbiddenRead('itemAdmission', args),
      settleDelegationResult: (...args: unknown[]): Promise<never> =>
        mockForbiddenRead('settleDelegationResult', args),
      updateCardState: (...args: unknown[]): Promise<never> =>
        mockForbiddenRead('updateCardState', args),
      withChildStreamTarget: (...args: unknown[]): Promise<never> =>
        mockForbiddenRead('withChildStreamTarget', args),
      openChildStream: (...args: unknown[]): Promise<never> =>
        mockForbiddenRead('openChildStream', args),
      commitChildStream: (...args: unknown[]): Promise<never> =>
        mockForbiddenRead('commitChildStream', args),
      readChildStreamContent: (...args: unknown[]): Promise<never> =>
        mockForbiddenRead('readChildStreamContent', args),
      childStreamCompatibilityPage: (
        ...args: Parameters<ChatStateService['childStreamCompatibilityPage']>
      ): ReturnType<ChatStateService['childStreamCompatibilityPage']> =>
        mockMixedPort
          ? mockTrace.call('stream.compatibilityPage', streamId, args, () =>
              Promise.resolve({
                ok: true,
                items: [],
                hasMore: false,
                streamRevision: 0,
                readRevision: 0,
              }),
            )
          : mockForbiddenRead('childStreamCompatibilityPage', args),
      generation: (
        ...args: Parameters<DelegationRecordReadPort['generation']>
      ): ReturnType<DelegationRecordReadPort['generation']> =>
        mockMixedPort
          ? mockMixedPort.generation(...args)
          : mockForbiddenRead('generation', args),
      resultByGeneration: (
        ...args: Parameters<DelegationRecordReadPort['resultByGeneration']>
      ): ReturnType<DelegationRecordReadPort['resultByGeneration']> =>
        mockMixedPort
          ? mockMixedPort.resultByGeneration(...args)
          : mockForbiddenRead('resultByGeneration', args),
      generationsPage: (
        ...args: Parameters<DelegationRecordReadPort['generationsPage']>
      ): ReturnType<DelegationRecordReadPort['generationsPage']> =>
        mockMixedPort
          ? mockMixedPort.generationsPage(...args)
          : mockForbiddenRead('generationsPage', args),
      appendReceipt: (...args: unknown[]): Promise<never> =>
        mockForbiddenRead('appendReceipt', args),
      receipt: (...args: unknown[]): Promise<never> =>
        mockForbiddenRead('receipt', args),
      open: (...args: unknown[]): Promise<never> =>
        mockForbiddenRead('open', args),
      appendChanges: (...args: unknown[]): Promise<never> =>
        mockForbiddenRead('appendChanges', args),
      flush: (...args: unknown[]): Promise<never> =>
        mockForbiddenRead('flush', args),
      result: (...args: unknown[]): Promise<never> =>
        mockForbiddenRead('result', args),
      resultBySettlementKey: (...args: unknown[]): Promise<never> =>
        mockForbiddenRead('resultBySettlementKey', args),
      resultAnswerRange: (...args: unknown[]): Promise<never> =>
        mockForbiddenRead('resultAnswerRange', args),
      page: (...args: unknown[]): Promise<never> =>
        mockForbiddenRead('page', args),
      message: (...args: unknown[]): Promise<never> =>
        mockForbiddenRead('message', args),
      contentRange: (...args: unknown[]): Promise<never> =>
        mockForbiddenRead('contentRange', args),
      resultsPage: (...args: unknown[]): Promise<never> =>
        mockForbiddenRead('resultsPage', args),
      current: (...args: unknown[]): Promise<never> =>
        mockForbiddenRead('current', args),
      registerGeneration: (...args: unknown[]): Promise<never> =>
        mockForbiddenRead('registerGeneration', args),
      beginSettlement: (...args: unknown[]): Promise<never> =>
        mockForbiddenRead('beginSettlement', args),
      settle: (...args: unknown[]): Promise<never> =>
        mockForbiddenRead('settle', args),
      getChildStreamState: (
        ...args: Parameters<
          RepositoryDelegationTranscriptChatState['getChildStreamState']
        >
      ): ReturnType<
        RepositoryDelegationTranscriptChatState['getChildStreamState']
      > => {
        const [scope, target] = args;
        if (target.kind !== 'delegation')
          return mockForbiddenRead('getChildStreamState', args);
        return mockMixedPort
          ? mockMixedPort
              .getChildStreamState(scope, target)
              .then((): undefined => undefined)
          : mockForbiddenRead('getChildStreamState', args);
      },
      getChildStreamMessage: (...args: unknown[]): Promise<never> =>
        mockForbiddenRead('getChildStreamMessage', args),
      getChildStreamPage: (...args: unknown[]): Promise<never> =>
        mockForbiddenRead('getChildStreamPage', args),
      readStoredParentMessage: (
        ...args: Parameters<DelegationRecordReadPort['readStoredParentMessage']>
      ): ReturnType<DelegationRecordReadPort['readStoredParentMessage']> =>
        mockMixedPort
          ? mockMixedPort.readStoredParentMessage(...args)
          : mockForbiddenRead('readStoredParentMessage', args),

      subscribe: (listener: unknown): (() => void) => {
        void listener;
        return () => undefined;
      },
    } satisfies HostDouble & Record<string, unknown>;
  },
}));

jest.mock('../services/portal-chat-tabs-cache', () => ({
  portalChatTabsCache: {
    read: (
      ...args: Parameters<typeof mockPortalRead>
    ): ReturnType<typeof mockPortalRead> => mockPortalRead(...args),
  },
}));

jest.mock('../agents/delegation/route-runtime', () => ({
  DelegationRouteRuntime: jest.fn(() => ({
    resolve: (): Promise<never> => Promise.reject(new Error('unused route')),
    release: (): void => undefined,
    dispose: (): void => undefined,
    discoverCapabilities: (): Promise<{ capabilities: [] }> =>
      Promise.resolve({ capabilities: [] }),
  })),
}));

jest.mock('../agents/delegation/claude-runner', () => ({
  createClaudeDelegationRunner: (): {
    harnessId: string;
    version: string;
    capabilities: string[];
  } => ({ harnessId: 'claude', version: '1', capabilities: [] }),
}));
jest.mock('../agents/delegation/codex-runner', () => ({
  createCodexDelegationRunner: (): {
    harnessId: string;
    version: string;
    capabilities: string[];
  } => ({ harnessId: 'codex', version: '1', capabilities: [] }),
}));
jest.mock('../agents/delegation/cursor-runner', () => ({
  createCursorDelegationRunner: (): {
    harnessId: string;
    version: string;
    capabilities: string[];
  } => ({ harnessId: 'cursor', version: '1', capabilities: [] }),
}));
jest.mock('../agents/delegation/copilot-runner', () => ({
  createCopilotDelegationRunner: (): {
    harnessId: string;
    version: string;
    capabilities: string[];
  } => ({ harnessId: 'copilot', version: '1', capabilities: [] }),
}));
jest.mock('../agents/delegation/opencode-runner', () => ({
  createOpenCodeDelegationRunner: (): {
    harnessId: string;
    version: string;
    capabilities: string[];
  } => ({ harnessId: 'opencode', version: '1', capabilities: [] }),
}));
jest.mock('../cursor/connection', () => ({
  getCursorAccountGeneration: (): number => 1,
}));
jest.mock('../copilot/connection', () => ({
  getCopilotAccountGeneration: (): number => 1,
}));
jest.mock('../opencode/connection', () => ({
  getOpenCodeConnectionGeneration: (): number => 1,
}));
jest.mock('@canopy/desktop-shared/node/delegation/runner-registry', () => ({
  AgentRunnerRegistry: jest.fn(() => ({ register: (): void => undefined })),
}));
jest.mock('../agents/session-manager', () => ({
  getSession: (): undefined => undefined,
  getAllActiveSessionInfos: (): [] => [],
  getActiveSessionInfos: (): [] => [],
  getProviderAuthGeneration: (): number => 1,
  getSessionPluginSelections: (): undefined => undefined,
  getSessionGlobalPluginDefaultsRevision: (): undefined => undefined,
  getGlobalPluginDefaultsRevision: (): number => 0,
  subscribeGlobalPluginDefaultsRevision: (): (() => void) => () => undefined,
}));
jest.mock('../lib/main-process-logging', () => ({
  logMainProcessWarn: (): void => undefined,
  logMainProcessError: (...args: unknown[]): void => {
    mockWatcherErrors.push(args);
  },
}));

jest.mock('../pipelines/pipeline-service', () => ({}));
jest.mock('../services/background-execution-context', () => ({
  backgroundExecutionContextEnabled: (): boolean => false,
}));
jest.mock('../lib/github-workflow-run-observer', () => ({
  getGitHubWorkflowRunObserver: (): object => ({
    configure: (): void => undefined,
    stop: (): void => undefined,
  }),
}));
jest.mock('../lib/github-pull-request-observer', () => ({
  getGitHubPullRequestObserver: (): object => ({
    configure: (): void => undefined,
    stop: (): void => undefined,
  }),
}));
jest.mock('../lib/chat-tabs-reader', () => ({
  readChatTabsFile: (): Promise<ChatTabsFile> => {
    const tabs: ChatTabsFile = { version: 1, activeTabId: '', tabs: [] };
    // Preserve this legacy empty-tab fixture's null runtime value.
    Reflect.set(tabs, 'activeTabId', null);
    return Promise.resolve(tabs);
  },
}));
jest.mock('../lib/cowork-work-entries', () => ({
  resolveWorkEntryForChat: (): Promise<null> => Promise.resolve(null),
  listWorkEntryIds: (): Promise<[]> => Promise.resolve([]),
  listWorkEntries: (): Promise<[]> => Promise.resolve([]),
}));
import {
  configureManagedDelegationReaders,
  createManagedDelegationSession,
  messageManagedDelegationForUser,
  readManagedDelegationRootsForUser,
  readManagedDelegationTranscriptForUser,
  readManagedDelegationTreeForUser,
} from '../agents/delegation/service';
import { closeDelegationScope } from '../agents/delegation/lifecycle';
import { registerWorkspaceTypes } from '../lib/workspace-registry';
import { loadDelegationRecoveryMutations } from '../agents/delegation/recovery';
function transcript(
  delegationId: string,
  runGeneration: number,
  sequence: number,
  options: {
    readonly description?: string;
    readonly prompt?: string;
    readonly status?: AgentDelegationSnapshot['status'];
    readonly text?: string;
    readonly items?: readonly AgentDelegationTranscriptItem[];
    readonly store?: 'chat-log-v1';
    readonly snapshot?: Partial<AgentDelegationSnapshot>;
  } = {},
): AgentDelegationTranscript {
  const status = options.status ?? 'completed';
  return {
    delegationId,
    runGeneration,
    sequence,
    parentHarnessId: 'codex',
    parentTurnId: 'turn',
    parentToolCallId: `call-${delegationId}`,
    createdAt: 100 + sequence,
    task: {
      description: options.description ?? 'Review',
      prompt: options.prompt ?? 'Inspect retained evidence',
      executionMode: 'background',
    },
    snapshot: {
      delegationId,
      status,
      outputTruncated: false,
      routeSnapshot: publicRouteFixture(),
      ...(status === 'completed'
        ? { finalText: options.text ?? 'Complete' }
        : {}),
      ...options.snapshot,
    },
    transcript: [...(options.items ?? [])],
    ...(options.store
      ? { transcriptStore: options.store, transcriptMode: 'patch' as const }
      : {}),
  };
}

function textItem(
  id: string,
  sequence: number,
  text: string,
): AgentDelegationTranscriptItem {
  return { id, sequence, occurredAt: sequence, type: 'text', text };
}

function publicRouteFixture(): ReturnType<typeof routeFixture> {
  const route = { ...routeFixture() };
  delete route.authAccountKey;
  return route;
}

function task(): StoredDelegation['task'] {
  return {
    modelId: 'logical-review-model',
    description: 'Review',
    prompt: 'Inspect retained evidence',
    contextPolicy: 'task_only',
    isolation: 'shared_worktree',
    executionMode: 'background',
  };
}

function storedRecord(
  id: string,
  options: {
    readonly version: 1 | 2;
    readonly chatId?: string;
    readonly createdAt: number;
    readonly generation?: number;
    readonly sequence?: number;
    readonly status?: StoredDelegation['state']['status'];
    readonly phase?: StoredDelegation['launch']['phase'];
    readonly items?: readonly AgentDelegationTranscriptItem[];
    readonly history?: readonly AgentDelegationTranscript[];
    readonly admission?: StoredDelegation['admission'];
    readonly finishedAt?: number;
  },
): StoredDelegation {
  const generation = options.generation ?? 1;
  const status = options.status ?? 'completed';
  const phase =
    options.phase ?? (status === 'completed' ? 'settled' : 'starting');
  const chatId = options.chatId ?? 'reader-chat';
  return {
    version: options.version,
    ...(options.version === 2
      ? { transcriptRevision: options.sequence ?? 1 }
      : {}),
    ...(options.history ? { history: [...options.history] } : {}),
    ...(options.admission ? { admission: options.admission } : {}),
    parent: {
      harnessId: 'codex',
      projectId: 'reader-project',
      worktreeId: 'reader-worktree',
      chatId,
      sessionKey: `reader-project/reader-worktree/${chatId}`,
      turnId: 'turn',
      toolCallId: `call-${id}`,
      runtimeGeneration: 1,
      depth: 0,
    },
    task: task(),
    route: publicRouteFixture(),
    callKey: 'a'.repeat(64),
    requestHash: 'b'.repeat(64),
    createdAt: options.createdAt,
    deadlineAt: options.createdAt + 1000,
    state: {
      delegationId: id,
      runGeneration: generation,
      sequence: options.sequence ?? 1,
      status,
      outputTruncated: false,
      ...(status === 'completed' ? { finalText: `Final result ${id}` } : {}),
      ...(status === 'completed' && options.finishedAt !== undefined
        ? { finishedAt: options.finishedAt }
        : {}),
      ...(options.items ? { transcript: [...options.items] } : {}),
    },
    launch: {
      version: 1,
      delegationId: id,
      launchKey: 'a'.repeat(64),
      runGeneration: generation,
      phase,
      ...(status === 'completed' ? { terminalStatus: 'completed' } : {}),
    },
    delivery: { status: 'unclaimed' },
  };
}

function parentTurn(): PersistedChatMessage {
  return {
    id: 'turn',
    role: 'user',
    timestamp: 90,
    blocks: [{ type: 'text', text: 'Please inspect the retained task.' }],
  };
}

function chatTabs(messages: PersistedChatMessage[]): ChatTabsFile {
  const tab: PersistedChatTab = {
    id: 'reader-chat',
    title: 'Reader fixture',
    createdAt: '2026-10-17T00:00:00.000Z',
    messages,
  };
  return { version: 1, activeTabId: tab.id, tabs: [tab] };
}

async function saveRecords(
  scope: ChatScope,
  records: readonly StoredDelegation[],
): Promise<void> {
  const storage = new FileDelegationStorage(
    path.join(
      mockDataRoot,
      scope.projectId,
      scope.worktreeId,
      'delegation',
      'runs',
    ),
  );
  for (const record of records) await storage.commit(record);
}

type Composition = 'absent' | 'naive' | 'production';
type Scenario =
  | 'replay'
  | 'tree-live'
  | 'tree-snapshots'
  | 'roots-live'
  | 'transcript-live'
  | 'transcript-revision'
  | 'transcript-historical'
  | 'transcript-offline'
  | 'transcript-missing'
  | 'transcript-private'
  | 'transcript-live-corrupt'
  | 'message-missing'
  | 'message-foreign'
  | 'message-private'
  | 'transcript-failing'
  | 'message-empty'
  | 'message-overlong'
  | 'message-invalid-operation'
  | 'message-pending-missing'
  | 'message-pending-private'
  | 'message-pending-failing'
  | 'message-offline'
  | 'message-broker-only'
  | 'message-corrected'
  | 'tree-offline'
  | 'roots-offline'
  | 'recovery';
const scope = { projectId: 'reader-project', worktreeId: 'reader-worktree' };
const target = { ...scope, chatId: 'reader-chat' };
const id = '00000000-0000-4000-8000-000000000001';
const actorId = '00000000-0000-4000-8000-000000000002';
const diskId = '00000000-0000-4000-8000-000000000003';
const operationId = '00000000-0000-4000-8000-000000000004';
const options = {
  ...target,
  cwd: '/worktree',
  approvalMode: 'full-access' as const,
};

async function session(published?: AgentDelegationTranscript[]): Promise<void> {
  const created = await createManagedDelegationSession({
    harness: 'codex',
    sessionKey: `${scope.projectId}/${scope.worktreeId}/${target.chatId}`,
    currentOptions: () => options,
    currentTurn: () => 'current-turn',
    getWindow: () => null,
    ...(published
      ? {
          onTranscript: (run: AgentDelegationTranscript): void => {
            published.push(run);
          },
        }
      : {}),
  });
  if (!mockTrace.enabled)
    mockTrace.expectedFreshSessionEpoch = created.parent.context(
      'trace',
      'trace',
    )?.runtimeGeneration;
}

async function receiptBytes(): Promise<readonly string[]> {
  const directory = path.join(
    mockDataRoot,
    scope.projectId,
    scope.worktreeId,
    'delegation',
    'user-messages',
  );
  try {
    const names = (await readdir(directory))
      .filter((name) => name.endsWith('.json'))
      .sort();
    return await Promise.all(
      names.map((name) => readFile(path.join(directory, name), 'utf8')),
    );
  } catch (error) {
    if (
      typeof error === 'object' &&
      error !== null &&
      'code' in error &&
      error.code === 'ENOENT'
    )
      return [];
    throw error;
  }
}

async function exercise(
  scenario: Scenario,
  version: 1 | 2,
  composition: Composition,
): Promise<{
  output: string;
  trace: string;
  sourceCalls: number;
  sourceIds: readonly string[];
  transcripts: string;
  snapshots: string;
}> {
  jest.spyOn(Date, 'now').mockReturnValue(FIXED_NOW);
  const directory = await mkdtemp(path.join(tmpdir(), 'legacy-composition-'));
  mockDataRoot = directory;
  mockTrace = new DelegationIoTrace(
    `${scope.projectId}/${scope.worktreeId}`,
    directory,
  );
  const base = storedRecord(id, {
    version,
    createdAt: 100,
    status: 'running',
    ...(scenario === 'message-foreign' ? { chatId: 'foreign-chat' } : {}),
    items: [textItem('disk-answer', 1, 'Retained answer')],
    ...(scenario === 'transcript-historical'
      ? {
          generation: 2,
          history: [
            transcript(id, 1, 1, {
              items: [textItem('old-answer', 1, 'Historical answer')],
            }),
          ],
        }
      : {}),
  });
  const actor = storedRecord(actorId, {
    version,
    createdAt: 200,
    status: 'running',
  });
  const disk = storedRecord(diskId, { version, createdAt: 300 });
  mockRevisionAtBarrier = false;
  mockRecords = [base, actor];
  mockRuns = [
    transcript(actorId, 1, 3, { status: 'running' }),
    transcript(id, scenario === 'transcript-historical' ? 2 : 1, 2, {
      status: 'running',
      items: [textItem('live-answer', 1, 'Live answer')],
    }),
  ];
  mockGetCompatibilityTabs.mockImplementation((...args) =>
    mockTrace.call('compatibility.tabs', undefined, args, () =>
      Promise.resolve(chatTabs([parentTurn()])),
    ),
  );
  mockGetCompatibilityArchives.mockImplementation((...args) =>
    mockTrace.call('compatibility.archives', undefined, args, () =>
      Promise.resolve({ version: 1, archived: [] }),
    ),
  );
  let sourceCalls = 0;
  const sourceIds: string[] = [];
  const source: DelegationReadMetadataSource = (record) => {
    sourceCalls += 1;
    sourceIds.push(record.state.delegationId);
    return readMetadataOfRecord(record);
  };
  // Setup does not install the candidate composition or enter the trace.
  const setupDispose =
    composition === 'production'
      ? undefined
      : configureManagedDelegationReaders({});
  let dispose: (() => void) | undefined;
  try {
    // Deliberately not broker insertion order, with one disk-only and one actor-only id.
    await saveRecords(target, [disk, base]);
    const live = [
      'replay',
      'tree-live',
      'tree-snapshots',
      'roots-live',
      'transcript-live',
      'transcript-revision',
      'transcript-live-corrupt',
      'transcript-historical',
      'message-broker-only',
    ].includes(scenario);
    if (live) await session();
    const file = path.join(
      directory,
      scope.projectId,
      scope.worktreeId,
      'delegation',
      'runs',
      `${id}.json`,
    );
    if (
      scenario === 'transcript-missing' ||
      scenario === 'message-pending-missing' ||
      scenario === 'message-missing' ||
      scenario === 'transcript-live'
    )
      await rm(file);
    if (
      scenario === 'transcript-private' ||
      scenario === 'message-pending-private' ||
      scenario === 'message-private'
    )
      await chmod(file, 0o644);
    if (scenario === 'transcript-live-corrupt') {
      await writeFile(file, '{invalid JSON', { mode: 0o600 });
      await chmod(file, 0o600);
    }
    setupDispose?.();
    if (composition === 'absent')
      dispose = configureManagedDelegationReaders({});
    if (composition === 'naive')
      dispose = configureManagedDelegationReaders({
        readMetadata: source,
        reader: mockTrace.throwingReader(),
      });
    mockTrace.storage();
    if (
      [
        'transcript-failing',
        'message-pending-failing',
        'message-empty',
        'message-overlong',
        'message-invalid-operation',
      ].includes(scenario)
    ) {
      jest
        .spyOn(FileDelegationStorage.prototype, 'loadOne')
        .mockImplementation((key) =>
          mockTrace.call('files.loadOne', key, [key], () =>
            Promise.reject(new Error('record read forbidden')),
          ),
        );
    }
    if (scenario.startsWith('message-pending-')) {
      jest
        .spyOn(FileManagedDelegationMessageStorage.prototype, 'commit')
        .mockImplementation((receipt) =>
          mockTrace.call(
            `receipt.${receipt.status}`,
            receipt.operationId,
            [receipt],
            () => Promise.reject(new Error('pending receipt unavailable')),
          ),
        );
    }
    sourceCalls = 0;
    sourceIds.length = 0;
    mockRevisionAtBarrier = scenario === 'transcript-revision';
    mockTrace.enabled = true;
    let output: unknown;
    try {
      if (scenario === 'replay') {
        const published: AgentDelegationTranscript[] = [];
        await session(published);
        output = published;
      } else if (scenario.startsWith('tree-'))
        output = await readManagedDelegationTreeForUser(target);
      else if (scenario.startsWith('roots-'))
        output = await readManagedDelegationRootsForUser(scope);
      else if (scenario.startsWith('transcript-'))
        output = await readManagedDelegationTranscriptForUser({
          ...target,
          delegationId: id,
          ...(scenario === 'transcript-historical' ? { runGeneration: 1 } : {}),
        });
      else if (scenario === 'recovery')
        output = await loadDelegationRecoveryMutations(
          scope,
          chatTabs([parentTurn()]),
          { version: 1, archived: [] },
          composition === 'naive' ? { readMetadata: source } : undefined,
        );
      else {
        const request = {
          ...target,
          delegationId: scenario === 'message-broker-only' ? actorId : id,
          operationId,
          operation: 'follow_up' as const,
          message:
            scenario === 'message-empty' || scenario === 'message-corrected'
              ? ''
              : scenario === 'message-overlong'
                ? 'x'.repeat(32769)
                : 'Continue',
        };
        if (scenario === 'message-invalid-operation')
          Reflect.set(request, 'operation', 'invalid');
        output = await messageManagedDelegationForUser(request);
        if (scenario === 'message-corrected')
          output = [
            output,
            await messageManagedDelegationForUser({
              ...request,
              message: 'Corrected',
            }),
          ];
      }
    } catch (error) {
      output = { rejected: mockTrace.normalize(error) };
    }
    mockTrace.enabled = false;
    const receipts = await receiptBytes();
    if (composition === 'absent') {
      if (scenario === 'replay') expect(output).toEqual(mockRuns);
      if (
        scenario === 'transcript-live' ||
        scenario === 'transcript-live-corrupt' ||
        scenario === 'transcript-revision' ||
        scenario === 'transcript-historical' ||
        scenario === 'transcript-offline'
      )
        expect(output).toMatchObject({ ok: true });
      if (scenario === 'roots-live')
        expect(output).toEqual([expect.objectContaining({ live: 2 })]);
      if (
        [
          'message-empty',
          'message-overlong',
          'message-invalid-operation',
          'message-pending-missing',
          'message-pending-private',
          'message-pending-failing',
        ].includes(scenario)
      ) {
        expect(
          mockTrace.entries.filter(
            (entry) => entry.operation === 'files.loadOne',
          ),
        ).toEqual([]);
      }
      if (scenario === 'message-empty' || scenario === 'message-overlong')
        expect(output).toEqual({
          ok: false,
          code: 'invalid_request',
          error: 'A non-empty message of at most 32768 characters is required.',
        });
      if (
        ['message-missing', 'message-foreign', 'message-private'].includes(
          scenario,
        )
      ) {
        expect(output).toMatchObject({ ok: false });
        expect(
          mockTrace.entries
            .filter((entry) =>
              /^receipt\.(pending|complete)$/.test(entry.operation),
            )
            .map((entry) => entry.operation),
        ).toEqual(['receipt.pending', 'receipt.complete']);
        expect(receipts).toHaveLength(1);
        expect(JSON.parse(receipts[0] ?? '')).toMatchObject({
          status: 'complete',
        });
      }
      for (const bytes of receipts) expect(bytes).not.toContain('"codec"');
      if (scenario === 'transcript-live')
        expect(
          mockTrace.entries.filter(
            (entry) => entry.operation === 'files.loadOne',
          ),
        ).toEqual([]);
    }
    expect(
      mockTrace.entries.filter((entry) =>
        /^(reader|stream|registry)\./.test(entry.operation),
      ),
    ).toEqual([]);
    return {
      output: JSON.stringify(mockTrace.normalize({ output, receipts })),
      trace: JSON.stringify(mockTrace.entries),
      transcripts: JSON.stringify(
        mockTrace.entries.filter(
          (entry) =>
            entry.operation === 'broker.transcripts' ||
            entry.operation === 'broker.writeBarrier',
        ),
      ),
      snapshots: JSON.stringify(
        mockTrace.entries.filter(
          (entry) =>
            entry.operation === 'broker.list' ||
            entry.operation === 'broker.inspect',
        ),
      ),
      sourceCalls,
      sourceIds,
    };
  } finally {
    mockTrace.enabled = false;
    dispose?.();
    await closeDelegationScope(scope);
    jest.restoreAllMocks();
    await rm(directory, { recursive: true, force: true });
  }
}

beforeAll(() => {
  registerWorkspaceTypes(new Map());
});
beforeEach(() => {
  jest.spyOn(Date, 'now').mockReturnValue(FIXED_NOW);
});
afterEach(() => {
  jest.restoreAllMocks();
});

it('normalizes only the recorded fresh epoch and preserves user-stop nonce identity', () => {
  const capture = (
    epoch: number,
    nonces: readonly string[],
  ): DelegationIoTrace => {
    const trace = new DelegationIoTrace('normalization', '/temporary');
    trace.expectedFreshSessionEpoch = epoch;
    trace.enabled = true;
    for (const nonce of nonces) {
      const parent = {
        sessionKey: 'session',
        harnessId: 'codex',
        depth: 0,
        runtimeGeneration: epoch,
        toolCallId: `user-stop:${nonce}`,
      };
      trace.sync('broker.manage', id, [parent], () => parent);
    }
    // A stale actor epoch must remain visible even in a broker argument.
    trace.sync(
      'broker.manage',
      id,
      [
        {
          sessionKey: 'session',
          harnessId: 'codex',
          depth: 0,
          runtimeGeneration: epoch - 1,
        },
      ],
      () => undefined,
    );
    return trace;
  };
  const first = capture(42, ['one', 'two', 'one']);
  const second = capture(84, ['other-one', 'other-two', 'other-one']);
  expect(first.entries.slice(0, 3).map((entry) => entry.arguments)).toEqual(
    second.entries.slice(0, 3).map((entry) => entry.arguments),
  );
  expect(first.entries.slice(0, 3).map((entry) => entry.arguments)).toEqual([
    [
      expect.objectContaining({
        runtimeGeneration: '<ACTOR_GENERATION>',
        toolCallId: 'user-stop:<CALL_ID_1>',
      }),
    ],
    [
      expect.objectContaining({
        runtimeGeneration: '<ACTOR_GENERATION>',
        toolCallId: 'user-stop:<CALL_ID_2>',
      }),
    ],
    [
      expect.objectContaining({
        runtimeGeneration: '<ACTOR_GENERATION>',
        toolCallId: 'user-stop:<CALL_ID_1>',
      }),
    ],
  ]);
  expect(first.entries[3]?.arguments).toEqual([
    expect.objectContaining({ runtimeGeneration: 41 }),
  ]);
  expect(first.entries[0]?.result).toEqual(
    expect.objectContaining({
      runtimeGeneration: 42,
      toolCallId: 'user-stop:one',
    }),
  );
  const unrecorded = new DelegationIoTrace('normalization', '/temporary');
  unrecorded.enabled = true;
  unrecorded.sync(
    'broker.manage',
    id,
    [
      {
        sessionKey: 'session',
        harnessId: 'codex',
        depth: 0,
        runtimeGeneration: 42,
      },
    ],
    () => undefined,
  );
  expect(unrecorded.entries[0]?.arguments).toEqual([
    expect.objectContaining({ runtimeGeneration: 42 }),
  ]);
});

const sensitive: readonly Scenario[] = [
  'replay',
  'tree-live',
  'tree-snapshots',
  'roots-live',
  'transcript-live',
  'transcript-revision',
  'transcript-historical',
  'transcript-offline',
  'transcript-missing',
  'transcript-private',
  'transcript-live-corrupt',
  'message-missing',
  'message-foreign',
  'message-private',
  'transcript-failing',
  'message-empty',
  'message-overlong',
  'message-invalid-operation',
  'message-pending-missing',
  'message-pending-private',
  'message-pending-failing',
  'message-offline',
  'message-broker-only',
  'message-corrected',
];
const neutral: readonly Scenario[] = [
  'tree-offline',
  'roots-offline',
  'recovery',
];
for (const version of [1, 2] as const) {
  describe(`v${version} K1`, () => {
    for (const composition of ['absent', 'production', 'naive'] as const) {
      for (const scenario of [...sensitive, ...neutral]) {
        const test = it;
        test(`${composition}: ${scenario} preserves output bytes and ordered I/O`, async () => {
          const baseline = await exercise(scenario, version, 'absent');
          jest.spyOn(Date, 'now').mockReturnValue(FIXED_NOW);
          const candidate = await exercise(scenario, version, composition);
          if (scenario === 'tree-live')
            expect(candidate.transcripts).toBe(baseline.transcripts);
          if (scenario === 'tree-snapshots')
            expect(candidate.snapshots).toBe(baseline.snapshots);
          expect(candidate.output).toBe(baseline.output);
          expect(candidate.trace).toBe(baseline.trace);
          if (composition === 'naive' && neutral.includes(scenario)) {
            expect(candidate.sourceCalls).toBe(2);
            expect([...candidate.sourceIds].sort()).toEqual(
              [id, diskId].sort(),
            );
          }
        });
      }
    }
  });
}

async function coldWatch(
  version: 1 | 2,
  installed: boolean,
  savedWatcher?: string,
): Promise<{
  trace: string;
  sourceCalls: number;
  seed: string;
  output: string;
}> {
  const directory = await mkdtemp(path.join(tmpdir(), 'legacy-cold-watch-'));
  mockDataRoot = directory;
  mockTrace = new DelegationIoTrace(
    `${scope.projectId}/${scope.worktreeId}`,
    directory,
  );
  mockWatcherErrors.length = 0;
  await saveRecords(target, [
    storedRecord(id, { version, createdAt: 100, status: 'running' }),
  ]);
  const { getAppAdvisorWatcherService } =
    await import('../app-advisor/watchers');
  const watchers = getAppAdvisorWatcherService();
  watchers.shutdown();
  jest.useFakeTimers({ now: FIXED_NOW });
  let sourceCalls = 0;
  watchers.configure(
    {
      getMainWindow: () => null,
      getAppAdvisorWindow: () => null,
      ensureAppAdvisorWindow: (): Promise<never> =>
        Promise.reject(new Error('Unexpected window creation')),
      sendAppAdvisorWindowCommand: () => false,
      sendChatWindowCommand: () => false,
      deliverWatcherMessage: (): Promise<never> =>
        Promise.reject(new Error('Unexpected watcher message delivery')),
      onChange: () => undefined,
    },
    {
      deferStartupRecovery: true,
      ...(installed
        ? {
            readMetadata: (
              record: StoredDelegation,
            ): ReturnType<typeof readMetadataOfRecord> => {
              sourceCalls += 1;
              return readMetadataOfRecord(record);
            },
            recordReader: mockTrace.throwingReader(),
          }
        : {}),
    },
  );
  try {
    if (savedWatcher)
      await writeFile(path.join(directory, 'watchers.json'), savedWatcher, {
        mode: 0o600,
      });
    else {
      await writeFile(
        path.join(directory, 'watchers.json'),
        JSON.stringify({
          version: 1,
          watchers: [
            {
              id: 'legacy-cold-watch',
              trigger: 'managed_delegation_completion',
              status: 'active',
              target: {
                kind: 'managed_delegation',
                projectId: scope.projectId,
                worktreeId: scope.worktreeId,
              },
              runtimeState: {
                kind: 'managed_delegation',
                targets: [
                  { delegationId: id, runGeneration: 1, resultIndex: null },
                ],
              },
            },
          ],
        }),
      );
    }
    const seed = await readFile(path.join(directory, 'watchers.json'), 'utf8');
    mockTrace.storage();
    mockTrace.enabled = true;
    await watchers.reconcileAtStartup();
    await jest.advanceTimersByTimeAsync(1);
    await watchers.drain();
    mockTrace.enabled = false;
    expect(mockWatcherErrors).toEqual([]);
    expect(
      mockTrace.entries.filter((entry) =>
        /^(reader|stream|registry)\./.test(entry.operation),
      ),
    ).toEqual([]);
    expect(sourceCalls).toBe(0);
    expect(await watchers.list()).toEqual([]);
    expect(await watchers.listLegacyDelegateWatchers(scope)).toHaveLength(1);
    return {
      trace: JSON.stringify(mockTrace.entries),
      sourceCalls,
      seed,
      output: await readFile(path.join(directory, 'watchers.json'), 'utf8'),
    };
  } finally {
    mockTrace.enabled = false;
    watchers.shutdown();
    await watchers.drain();
    jest.useRealTimers();
    jest.restoreAllMocks();
    await rm(directory, { recursive: true, force: true });
  }
}

it.each([1, 2] as const)(
  'v%s raw legacy watch stays migration-only with the source installed',
  async (version) => {
    const baseline = await coldWatch(version, false);
    const installed = await coldWatch(version, true, baseline.seed);
    expect(installed.trace).toBe(baseline.trace);
    expect(installed.output).toBe(baseline.output);
  },
);

const streamId = '00000000-0000-4000-8000-000000000005';
function streamRecord(key = streamId): StoredDelegation {
  const legacy = storedRecord(key, {
    version: 2,
    createdAt: 400,
    generation: 2,
    status: 'running',
  });
  return decodeStoredDelegationV3({
    version: 3,
    parent: legacy.parent,
    task: legacy.task,
    route: legacy.route,
    callKey: legacy.callKey,
    requestHash: legacy.requestHash,
    createdAt: legacy.createdAt,
    state: legacy.state,
    launch: legacy.launch,
    delivery: legacy.delivery,
    readMetadata: {
      originAt: 400,
      lastActivityAt: 450,
      current: {
        store: 'stream',
        target: {
          kind: 'delegation',
          chatId: target.chatId,
          delegationId: key,
          runGeneration: 2,
        },
      },
    },
    registration: {
      runGeneration: 2,
      createdAt: 400,
      store: 'stream',
      origin: { kind: 'launch' },
      executionMode: 'background',
    },
    receipts: { commandReceipts: [], stopReceipts: [] },
    legacyPrefix: { history: [transcript(key, 1, 1)] },
  });
}

type MixedGate = 'replay' | 'tree' | 'transcript' | 'roots' | 'message';
async function mixedExercise(
  gate: MixedGate,
  version: 1 | 2,
  streamFailure: boolean,
): Promise<{
  legacy: string;
  trace: string;
  stream: unknown;
  portCalls: number;
}> {
  jest.spyOn(Date, 'now').mockReturnValue(FIXED_NOW);
  const directory = await mkdtemp(path.join(tmpdir(), 'mixed-composition-'));
  mockDataRoot = directory;
  mockTrace = new DelegationIoTrace(
    `${scope.projectId}/${scope.worktreeId}`,
    directory,
  );
  const stream = streamRecord();
  mockRecords = [
    storedRecord(actorId, { version, createdAt: 200, status: 'running' }),
    stream,
    storedRecord(id, { version, createdAt: 100, status: 'running' }),
  ];
  mockRuns = [
    transcript(actorId, 1, 3, { status: 'running' }),
    transcript(streamId, 2, 1, { status: 'running' }),
    transcript(id, 1, 2, { status: 'running' }),
  ];
  if (gate === 'roots') {
    const actorStreamId = '00000000-0000-4000-8000-000000000007';
    mockRecords.push(streamRecord(actorStreamId));
    mockRuns.push(transcript(actorStreamId, 2, 1, { status: 'running' }));
  }
  mockGetCompatibilityTabs.mockImplementation((...args) =>
    mockTrace.call('compatibility.tabs', undefined, args, () =>
      Promise.resolve(chatTabs([parentTurn()])),
    ),
  );
  mockGetCompatibilityArchives.mockResolvedValue({ version: 1, archived: [] });
  const generation = {
    entry: {
      version: 1 as const,
      kind: 'generation' as const,
      chatId: target.chatId,
      delegationId: streamId,
      runGeneration: 2,
      createdAt: 400,
      store: 'stream' as const,
      origin: { kind: 'launch' as const, anchorMessageId: 'turn' },
      executionMode: 'background' as const,
    },
    stream: null,
    result: null,
  };
  let portCalls = 0;
  const portCall = <T>(
    method: string,
    args: unknown[],
    value: T,
  ): Promise<T> => {
    portCalls += 1;
    return mockTrace.call(`stream.${method}`, streamId, args, () =>
      streamFailure &&
      (method === 'readStoredParentMessage' ||
        (gate === 'roots' && method === 'getChildStreamState'))
        ? Promise.reject(new Error('stream scope unavailable'))
        : Promise.resolve(value),
    );
  };
  mockMixedPort = {
    generation: (...args): ReturnType<DelegationRecordReadPort['generation']> =>
      portCall('generation', args, generation),
    resultByGeneration: (
      ...args
    ): ReturnType<DelegationRecordReadPort['resultByGeneration']> =>
      portCall('resultByGeneration', args, undefined),
    generationsPage: (
      ...args
    ): ReturnType<DelegationRecordReadPort['generationsPage']> =>
      portCall('generationsPage', args, {
        generations: [generation],
        hasMore: false,
      }),
    getChildStreamState: (
      ...args
    ): ReturnType<DelegationRecordReadPort['getChildStreamState']> =>
      portCall('getChildStreamState', args, undefined),
    readStoredParentMessage: (
      ...args
    ): ReturnType<DelegationRecordReadPort['readStoredParentMessage']> =>
      portCall('readStoredParentMessage', args, parentTurn()),
  };
  try {
    await saveRecords(
      target,
      [
        storedRecord(diskId, { version, createdAt: 300 }),
        stream,
        mockRecords[2],
      ].filter((record): record is StoredDelegation => record !== undefined),
    );
    await session();
    portCalls = 0;
    mockTrace.storage();
    mockTrace.enabled = true;
    let output: unknown;
    let streamOutput: unknown;
    let legacyBoundary: number | undefined;
    if (gate === 'replay') {
      const published: AgentDelegationTranscript[] = [];
      await session(published);
      output = published.filter((run) => run.delegationId !== streamId);
      streamOutput = published.filter((run) => run.delegationId === streamId);
    } else if (gate === 'tree') {
      try {
        const tree = await readManagedDelegationTreeForUser(target);
        output = tree.filter(
          (entry) => entry.snapshot.delegationId !== streamId,
        );
        streamOutput = tree.filter(
          (entry) => entry.snapshot.delegationId === streamId,
        );
      } catch (error) {
        if (!streamFailure) throw error;
        streamOutput = { failed: String(error) };
      }
    } else if (gate === 'roots') {
      try {
        streamOutput = await readManagedDelegationRootsForUser(scope);
      } catch (error) {
        streamOutput = { failed: String(error) };
      }
      // Roots computes stream activity first; failed metadata rejects the whole read.
      output = mockTrace.entries.filter(
        (entry) => entry.operation === 'broker.list',
      );
    } else if (gate === 'transcript') {
      output = await readManagedDelegationTranscriptForUser({
        ...target,
        delegationId: id,
      });
      streamOutput = await readManagedDelegationTranscriptForUser({
        ...target,
        delegationId: streamId,
      });
    } else {
      if (streamFailure)
        await chmod(
          path.join(
            directory,
            scope.projectId,
            scope.worktreeId,
            'delegation',
            'runs',
            `${streamId}.json`,
          ),
          0o644,
        );
      output = await messageManagedDelegationForUser({
        ...target,
        delegationId: id,
        operationId,
        operation: 'follow_up',
        message: 'Legacy continuation',
      });
      legacyBoundary = mockTrace.entries.length;
      streamOutput = await messageManagedDelegationForUser({
        ...target,
        delegationId: streamId,
        operationId: '00000000-0000-4000-8000-000000000006',
        operation: 'follow_up',
        message: 'Stream continuation',
      });
    }
    mockTrace.enabled = false;
    if (gate === 'message') {
      const bytes = await receiptBytes();
      expect(bytes.some((value) => value.includes('"codec":"stream"'))).toBe(
        !streamFailure,
      );
      expect(
        mockTrace.entries.filter(
          (entry) => entry.operation === 'broker.message',
        ),
      ).toHaveLength(streamFailure ? 1 : 2);
    }
    // Compare ordered legacy operations between successful/unavailable stream reads.
    const legacyTrace = mockTrace.entries
      .slice(0, legacyBoundary)
      .filter(
        (entry) =>
          !entry.operation.startsWith('stream.') &&
          entry.id !== streamId &&
          !(
            entry.operation === 'broker.message' &&
            JSON.stringify(entry.arguments).includes(streamId)
          ),
      );
    return {
      legacy: JSON.stringify(mockTrace.normalize(output)),
      trace: JSON.stringify(legacyTrace),
      stream: streamOutput,
      portCalls,
    };
  } finally {
    mockTrace.enabled = false;
    mockMixedPort = undefined;
    await closeDelegationScope(scope);
    jest.restoreAllMocks();
    await rm(directory, { recursive: true, force: true });
  }
}

for (const version of [1, 2] as const) {
  for (const gate of [
    'replay',
    'tree',
    'transcript',
    'roots',
    'message',
  ] as const) {
    it(`mixed v${version} ${gate}: production routing keeps legacy order while stream reads vary`, async () => {
      const success = await mixedExercise(gate, version, false);
      const failure = await mixedExercise(gate, version, true);
      if (gate !== 'tree') expect(failure.legacy).toBe(success.legacy);
      expect(failure.trace).toBe(success.trace);
      if (
        gate === 'tree' ||
        gate === 'transcript' ||
        gate === 'roots' ||
        gate === 'replay'
      )
        expect(success.portCalls).toBeGreaterThan(0);
      if (gate === 'transcript')
        expect(success.stream).toMatchObject({ ok: true });
      if (gate === 'roots')
        expect(success.stream).toEqual([expect.objectContaining({ live: 4 })]);
      if (gate === 'message')
        expect(success.stream).toMatchObject({ ok: false });
    });
  }
}

for (const order of ['router-first', 'service-first'] as const) {
  it(`module evaluation stays lazy: ${order}`, async () => {
    mockHostGetter.mockClear();
    await jest.isolateModulesAsync(async () => {
      if (order === 'router-first') {
        await import('../agents/delegation/host-read-composition');
        await import('../agents/delegation/service');
      } else {
        await import('../agents/delegation/service');
        await import('../agents/delegation/host-read-composition');
      }
    });
    expect(mockHostGetter).not.toHaveBeenCalled();
  });
}

it('refuses a late stream actor after a legacy pending receipt, completing the legacy codec', async () => {
  const directory = await mkdtemp(path.join(tmpdir(), 'late-stream-'));
  mockDataRoot = directory;
  mockTrace = new DelegationIoTrace(
    `${scope.projectId}/${scope.worktreeId}`,
    directory,
  );
  mockRecords = [storedRecord(id, { version: 2, createdAt: 100 })];
  mockRuns = [transcript(id, 1, 1)];
  mockGetCompatibilityTabs.mockResolvedValue(chatTabs([parentTurn()]));
  const restore = configureManagedDelegationReaders({});
  try {
    // eslint-disable-next-line @typescript-eslint/unbound-method -- Invoked with the current receipt storage receiver below.
    const original = FileManagedDelegationMessageStorage.prototype.commit;
    jest
      .spyOn(FileManagedDelegationMessageStorage.prototype, 'commit')
      .mockImplementation(async function (
        this: FileManagedDelegationMessageStorage,
        receipt,
      ) {
        await original.call(this, receipt);
        if (receipt.status === 'pending') {
          await session();
          mockRecords = [streamRecord(id)];
        }
      });
    mockTrace.enabled = true;
    const reply = await messageManagedDelegationForUser({
      ...target,
      delegationId: id,
      operationId,
      operation: 'follow_up',
      message: 'Continue',
    });
    mockTrace.enabled = false;
    expect(reply).toEqual({
      ok: false,
      code: 'failed',
      error: 'The delegate message could not be delivered.',
    });
    expect(
      mockTrace.entries.filter((entry) => entry.operation === 'broker.message'),
    ).toEqual([]);
    const receipts = await receiptBytes();
    expect(receipts).toHaveLength(1);
    expect(JSON.parse(receipts[0] ?? '')).toMatchObject({
      status: 'complete',
      result: reply,
    });
    expect(receipts[0]).not.toContain('"codec"');
  } finally {
    mockTrace.enabled = false;
    restore();
    await closeDelegationScope(scope);
    jest.restoreAllMocks();
    await rm(directory, { recursive: true, force: true });
  }
});

it('offline v3 requests use legacy validation and receipts and only the historical post-pending point read', async () => {
  const directory = await mkdtemp(path.join(tmpdir(), 'offline-v3-'));
  mockDataRoot = directory;
  mockTrace = new DelegationIoTrace(
    `${scope.projectId}/${scope.worktreeId}`,
    directory,
  );
  mockRecords = [];
  mockRuns = [];
  try {
    await saveRecords(target, [streamRecord()]);
    mockTrace.storage();
    mockTrace.enabled = true;
    const empty = await messageManagedDelegationForUser({
      ...target,
      delegationId: streamId,
      operationId,
      operation: 'follow_up',
      message: '',
    });
    expect(empty).toEqual({
      ok: false,
      code: 'invalid_request',
      error: 'A non-empty message of at most 32768 characters is required.',
    });
    expect(
      mockTrace.entries.filter((entry) => entry.operation === 'files.loadOne'),
    ).toEqual([]);
    const result = await messageManagedDelegationForUser({
      ...target,
      delegationId: streamId,
      operationId: '00000000-0000-4000-8000-000000000006',
      operation: 'follow_up',
      message: 'Continue',
    });
    expect(result).toMatchObject({ ok: false, code: 'parent_unavailable' });
    mockTrace.enabled = false;
    const operations = mockTrace.entries.map((entry) => entry.operation);
    expect(
      operations.filter((operation) => operation === 'files.loadOne'),
    ).toHaveLength(1);
    expect(operations.indexOf('files.loadOne')).toBeGreaterThan(
      operations.lastIndexOf('receipt.pending'),
    );
    for (const bytes of await receiptBytes())
      expect(bytes).not.toContain('"codec"');
  } finally {
    mockTrace.enabled = false;
    await closeDelegationScope(scope);
    jest.restoreAllMocks();
    await rm(directory, { recursive: true, force: true });
  }
});

it('ready authorized stream messages validate before record reads or pending receipts', async () => {
  const directory = await mkdtemp(
    path.join(tmpdir(), 'ready-stream-validation-'),
  );
  mockDataRoot = directory;
  mockTrace = new DelegationIoTrace(
    `${scope.projectId}/${scope.worktreeId}`,
    directory,
  );
  mockRecords = [streamRecord()];
  mockRuns = [transcript(streamId, 2, 1)];
  // Setup replay has no legacy prefix reader dependency; install it after the session is ready.
  const restore = configureManagedDelegationReaders({});
  try {
    await session();
    restore();
    mockTrace.storage();
    mockTrace.enabled = true;
    for (const request of [
      { operation: 'follow_up' as const, message: '' },
      { operation: 'follow_up' as const, message: 'x'.repeat(32769) },
    ]) {
      await expect(
        messageManagedDelegationForUser({
          ...target,
          delegationId: streamId,
          operationId,
          ...request,
        }),
      ).resolves.toEqual({
        ok: false,
        code: 'invalid_request',
        error: 'Invalid delegation message.',
      });
    }
    expect(
      mockTrace.entries.filter(
        (entry) =>
          entry.operation === 'files.loadOne' ||
          entry.operation === 'receipt.pending' ||
          entry.operation === 'broker.message',
      ),
    ).toEqual([]);
    expect(await receiptBytes()).toEqual([]);
  } finally {
    mockTrace.enabled = false;
    // The disposer is idempotent for the same saved composition.
    restore();
    await closeDelegationScope(scope);
    jest.restoreAllMocks();
    await rm(directory, { recursive: true, force: true });
  }
});
